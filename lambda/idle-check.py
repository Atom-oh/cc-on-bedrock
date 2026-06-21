"""
Idle Check Lambda for CC-on-Bedrock
Lightweight Lambda that checks ECS task metrics from CloudWatch Container Insights.

Returns idle status per task, used by warm-stop Lambda.
"""

import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any

import boto3
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
REGION = os.environ.get("REGION", "ap-northeast-2")
CLUSTER = os.environ.get("ECS_CLUSTER", "cc-on-bedrock-devenv")

# AWS clients
ecs = boto3.client("ecs", region_name=REGION)
cloudwatch = boto3.client("cloudwatch", region_name=REGION)

# Idle thresholds
IDLE_CPU_THRESHOLD = float(os.environ.get("IDLE_CPU_THRESHOLD", "5.0"))
IDLE_NETWORK_THRESHOLD = int(os.environ.get("IDLE_NETWORK_THRESHOLD", "1000"))  # bytes/sec


def handler(event: dict, context: Any) -> dict:
    """
    Main Lambda handler for idle check operations.

    Event format:
    {
        "task_arns": ["arn:aws:ecs:..."],  # Optional - if not provided, checks all running tasks
        "period_minutes": 30,              # Optional - period to check for idle status
    }

    Returns:
    {
        "tasks": [
            {
                "task_arn": "...",
                "task_id": "...",
                "user_id": "...",
                "is_idle": true/false,
                "idle_minutes": 30,
                "cpu_avg": 2.5,
                "network_bytes_avg": 500,
            }
        ]
    }
    """
    logger.info(f"Received event: {json.dumps(event)}")

    task_arns = event.get("task_arns")
    period_minutes = event.get("period_minutes", 30)

    try:
        # Get tasks to check
        if not task_arns:
            task_arns = list_running_tasks()

        if not task_arns:
            return success_response({"tasks": [], "message": "No running tasks"})

        # Check each task
        results = []
        for task_arn in task_arns:
            task_result = check_task_metrics(task_arn, period_minutes)
            if task_result:
                results.append(task_result)

        return success_response({"tasks": results})

    except ClientError as e:
        logger.error(f"AWS ClientError: {e}")
        return error_response(500, f"AWS error: {e.response['Error']['Message']}")
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        return error_response(500, f"Internal error: {str(e)}")


def list_running_tasks() -> list:
    """List all running tasks in the cluster."""
    tasks = []
    paginator = ecs.get_paginator("list_tasks")

    for page in paginator.paginate(cluster=CLUSTER, desiredStatus="RUNNING"):
        tasks.extend(page.get("taskArns", []))

    return tasks


def get_task_info(task_arn: str) -> dict | None:
    """Get task details including tags."""
    try:
        response = ecs.describe_tasks(
            cluster=CLUSTER,
            tasks=[task_arn],
            include=["TAGS"],
        )
        tasks = response.get("tasks", [])
        if not tasks:
            return None

        task = tasks[0]
        tags = {t["key"]: t["value"] for t in task.get("tags", [])}

        return {
            "task_arn": task_arn,
            "task_id": task_arn.split("/")[-1],
            "user_id": tags.get("username", tags.get("user_id", "unknown")),
            "department": tags.get("department", "default"),
            "started_at": task.get("startedAt"),
        }
    except ClientError as e:
        logger.error(f"Failed to describe task {task_arn}: {e}")
        return None


def check_task_metrics(task_arn: str, period_minutes: int) -> dict | None:
    """
    Check CPU and Network metrics for a task.
    Returns task status with idle determination.
    """
    task_info = get_task_info(task_arn)
    if not task_info:
        return None

    task_id = task_info["task_id"]
    user_id = task_info["user_id"]

    end_time = datetime.utcnow()
    start_time = end_time - timedelta(minutes=period_minutes)

    # Get CPU metrics
    cpu_avg = get_cpu_metrics(user_id, start_time, end_time)

    # Get Network metrics
    network_avg = get_network_metrics(user_id, start_time, end_time)

    # Determine if idle
    is_idle = cpu_avg < IDLE_CPU_THRESHOLD and network_avg < IDLE_NETWORK_THRESHOLD
    idle_minutes = period_minutes if is_idle else 0

    result = {
        "task_arn": task_arn,
        "task_id": task_id,
        "user_id": user_id,
        "is_idle": is_idle,
        "idle_minutes": idle_minutes,
        "cpu_avg": round(cpu_avg, 2),
        "network_bytes_avg": int(network_avg),
        "cpu_threshold": IDLE_CPU_THRESHOLD,
        "network_threshold": IDLE_NETWORK_THRESHOLD,
    }

    logger.info(f"Task {task_id} (user: {user_id}): idle={is_idle}, cpu={cpu_avg:.2f}%, network={network_avg:.0f}B/s")
    return result


def get_cpu_metrics(user_id: str, start_time: datetime, end_time: datetime) -> float:
    """Get average CPU utilization from CloudWatch."""
    try:
        # Try ECS service metrics first
        response = cloudwatch.get_metric_statistics(
            Namespace="AWS/ECS",
            MetricName="CPUUtilization",
            Dimensions=[
                {"Name": "ClusterName", "Value": CLUSTER},
                {"Name": "ServiceName", "Value": f"cc-user-{user_id}"},
            ],
            StartTime=start_time,
            EndTime=end_time,
            Period=300,
            Statistics=["Average"],
        )

        datapoints = response.get("Datapoints", [])
        if datapoints:
            return sum(dp["Average"] for dp in datapoints) / len(datapoints)

        # Fallback to Container Insights metrics
        response = cloudwatch.get_metric_statistics(
            Namespace="ECS/ContainerInsights",
            MetricName="CpuUtilized",
            Dimensions=[
                {"Name": "ClusterName", "Value": CLUSTER},
                {"Name": "ServiceName", "Value": f"cc-user-{user_id}"},
            ],
            StartTime=start_time,
            EndTime=end_time,
            Period=300,
            Statistics=["Average"],
        )

        datapoints = response.get("Datapoints", [])
        if datapoints:
            return sum(dp["Average"] for dp in datapoints) / len(datapoints)

        # No metrics found - return high value to prevent false idle detection
        # Standalone ECS tasks may not emit ServiceName-based metrics
        logger.warning(f"No CPU metrics found for user {user_id}, returning 100% (fail safe)")
        return 100.0

    except ClientError as e:
        logger.error(f"Failed to get CPU metrics: {e}")
        return 100.0  # Fail safe - don't mark as idle


def get_network_metrics(user_id: str, start_time: datetime, end_time: datetime) -> float:
    """Get average network throughput from CloudWatch."""
    try:
        # Container Insights network metrics
        response = cloudwatch.get_metric_statistics(
            Namespace="ECS/ContainerInsights",
            MetricName="NetworkRxBytes",
            Dimensions=[
                {"Name": "ClusterName", "Value": CLUSTER},
                {"Name": "ServiceName", "Value": f"cc-user-{user_id}"},
            ],
            StartTime=start_time,
            EndTime=end_time,
            Period=300,
            Statistics=["Average"],
        )

        rx_datapoints = response.get("Datapoints", [])
        rx_avg = sum(dp["Average"] for dp in rx_datapoints) / len(rx_datapoints) if rx_datapoints else 0

        response = cloudwatch.get_metric_statistics(
            Namespace="ECS/ContainerInsights",
            MetricName="NetworkTxBytes",
            Dimensions=[
                {"Name": "ClusterName", "Value": CLUSTER},
                {"Name": "ServiceName", "Value": f"cc-user-{user_id}"},
            ],
            StartTime=start_time,
            EndTime=end_time,
            Period=300,
            Statistics=["Average"],
        )

        tx_datapoints = response.get("Datapoints", [])
        tx_avg = sum(dp["Average"] for dp in tx_datapoints) / len(tx_datapoints) if tx_datapoints else 0

        # Return combined average (bytes per 5 min period -> bytes/sec)
        total_avg = (rx_avg + tx_avg) / 300
        return total_avg

    except ClientError as e:
        logger.error(f"Failed to get network metrics: {e}")
        return float("inf")  # Fail safe - don't mark as idle


def success_response(data: dict) -> dict:
    """Return success response."""
    return {
        "statusCode": 200,
        "body": json.dumps(data),
    }


def error_response(status_code: int, message: str) -> dict:
    """Return error response."""
    return {
        "statusCode": status_code,
        "body": json.dumps({"error": message}),
    }
