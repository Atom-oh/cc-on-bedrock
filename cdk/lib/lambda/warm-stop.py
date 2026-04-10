"""
Warm Stop Lambda for CC-on-Bedrock
Triggered by: EventBridge scheduled rule (every 5 min) or direct invocation

Actions:
- check_idle: Scan running ECS tasks, check idle status via CloudWatch metrics
- warm_stop: Stop idle container, trigger S3 sync, create EBS snapshot
- warm_resume: Called when user wants to restart - restore EBS/S3, start task
- schedule_shutdown: Batch stop all idle containers (called at 18:00)
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
VOLUMES_TABLE = os.environ.get("VOLUMES_TABLE", "cc-user-volumes")
IDLE_THRESHOLD_MINUTES = int(os.environ.get("IDLE_THRESHOLD_MINUTES", "30"))
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
EBS_LIFECYCLE_LAMBDA = os.environ.get("EBS_LIFECYCLE_LAMBDA", "cc-on-bedrock-ebs-lifecycle")

# AWS clients
ecs = boto3.client("ecs", region_name=REGION)
ec2 = boto3.client("ec2", region_name=REGION)
cloudwatch = boto3.client("cloudwatch", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION)
sns = boto3.client("sns", region_name=REGION)
lambda_client = boto3.client("lambda", region_name=REGION)

# DynamoDB table
table = dynamodb.Table(VOLUMES_TABLE)

# Idle CPU threshold (percentage)
IDLE_CPU_THRESHOLD = 5.0


def handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for warm stop operations."""
    logger.info(f"Received event: {json.dumps(event)}")

    action = event.get("action", "check_idle")

    try:
        if action == "check_idle":
            return check_idle(event)
        elif action == "warm_stop":
            return warm_stop(event)
        elif action == "warm_resume":
            return warm_resume(event)
        elif action == "schedule_shutdown":
            return schedule_shutdown(event)
        else:
            return error_response(400, f"Unknown action: {action}")
    except ClientError as e:
        logger.error(f"AWS ClientError: {e}")
        return error_response(500, f"AWS error: {e.response['Error']['Message']}")
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        return error_response(500, f"Internal error: {str(e)}")


def check_idle(event: dict) -> dict:
    """
    Scan running ECS tasks, check idle status via CloudWatch metrics.
    If idle for IDLE_THRESHOLD_MINUTES, send SNS warning notification and mark in DynamoDB.
    """
    logger.info(f"Checking idle tasks in cluster {CLUSTER}")

    # List all running tasks
    running_tasks = list_running_tasks()
    if not running_tasks:
        logger.info("No running tasks found")
        return success_response({"idle_tasks": [], "message": "No running tasks"})

    idle_tasks = []
    warned_tasks = []

    for task_arn in running_tasks:
        task_info = get_task_info(task_arn)
        if not task_info:
            continue

        user_id = task_info.get("user_id", "unknown")
        task_id = task_arn.split("/")[-1]

        # Check CPU utilization from CloudWatch
        is_idle, idle_minutes = check_task_idle_status(task_id, user_id, started_at=task_info.get("started_at"))

        if is_idle:
            logger.info(f"Task {task_id} (user: {user_id}) is idle for {idle_minutes} minutes")

            # Update DynamoDB with idle status
            update_idle_status(user_id, task_id, idle_minutes)

            if idle_minutes >= IDLE_THRESHOLD_MINUTES + 15:
                # Idle for 45+ minutes (30 threshold + 15 grace) -> trigger warm stop
                idle_tasks.append({
                    "task_arn": task_arn,
                    "user_id": user_id,
                    "idle_minutes": idle_minutes,
                    "action": "warm_stop_triggered",
                })
                # Trigger warm stop asynchronously
                trigger_warm_stop(user_id, task_arn)

            elif idle_minutes >= IDLE_THRESHOLD_MINUTES:
                # Idle for 30+ minutes -> send warning
                warned_tasks.append({
                    "task_arn": task_arn,
                    "user_id": user_id,
                    "idle_minutes": idle_minutes,
                    "action": "warning_sent",
                })
                send_idle_warning(user_id, idle_minutes)

    result = {
        "checked_tasks": len(running_tasks),
        "idle_tasks": idle_tasks,
        "warned_tasks": warned_tasks,
    }
    logger.info(f"Check idle result: {json.dumps(result)}")
    return success_response(result)


def warm_stop(event: dict) -> dict:
    """
    Stop idle container, trigger S3 sync (via SIGTERM to entrypoint), create EBS snapshot.

    Required: user_id
    Optional: task_arn (if not provided, looks up from running tasks)
    """
    user_id = event.get("user_id")
    task_arn = event.get("task_arn")

    if not user_id:
        return error_response(400, "Missing required parameter: user_id")

    logger.info(f"Warm stop initiated for user {user_id}")

    # Find task if not provided
    if not task_arn:
        task_arn = find_user_task(user_id)
        if not task_arn:
            return error_response(404, f"No running task found for user {user_id}")

    task_id = task_arn.split("/")[-1]

    # Step 1: Stop ECS task (triggers SIGTERM -> entrypoint S3 sync)
    logger.info(f"Stopping ECS task {task_id} for user {user_id}")
    try:
        ecs.stop_task(
            cluster=CLUSTER,
            task=task_arn,
            reason=f"Warm stop: idle timeout for user {user_id}",
        )
        logger.info(f"ECS task {task_id} stop initiated")
    except ClientError as e:
        if e.response["Error"]["Code"] != "InvalidParameterException":
            raise
        logger.warning(f"Task {task_id} may already be stopped: {e}")

    # Step 2: Invoke EBS lifecycle Lambda to snapshot+delete volume
    logger.info(f"Invoking EBS lifecycle Lambda for user {user_id}")
    try:
        lambda_client.invoke(
            FunctionName=EBS_LIFECYCLE_LAMBDA,
            InvocationType="Event",  # Async invocation
            Payload=json.dumps({
                "action": "snapshot_and_detach",
                "user_id": user_id,
            }),
        )
        logger.info(f"EBS snapshot initiated for user {user_id}")
    except ClientError as e:
        logger.error(f"Failed to invoke EBS lifecycle Lambda: {e}")
        # Continue anyway - task stop is the critical path

    # Step 3: Update DynamoDB status
    update_warm_stop_status(user_id, task_id)

    # Step 4: Send notification
    send_warm_stop_notification(user_id)

    return success_response({
        "user_id": user_id,
        "task_arn": task_arn,
        "status": "warm_stop_initiated",
    })


def warm_resume(event: dict) -> dict:
    """
    Resume a warm-stopped container: restore EBS from snapshot, start new task.

    Required: user_id
    Optional: az (availability zone for volume restore)
    """
    user_id = event.get("user_id")
    az = event.get("az", f"{REGION}a")

    if not user_id:
        return error_response(400, "Missing required parameter: user_id")

    logger.info(f"Warm resume initiated for user {user_id}")

    # Step 1: Check if user has a snapshot to restore
    volume_record = get_user_volume_record(user_id)
    if not volume_record:
        return error_response(404, f"No volume record found for user {user_id}")

    snapshot_id = volume_record.get("snapshot_id")
    if not snapshot_id:
        logger.info(f"No snapshot found for user {user_id}, will create fresh volume")

    # Step 2: Invoke EBS lifecycle Lambda to restore volume
    logger.info(f"Invoking EBS lifecycle Lambda for volume restore for user {user_id}")
    try:
        if snapshot_id:
            response = lambda_client.invoke(
                FunctionName=EBS_LIFECYCLE_LAMBDA,
                InvocationType="RequestResponse",
                Payload=json.dumps({
                    "action": "restore_from_snapshot",
                    "user_id": user_id,
                    "az": az,
                }),
            )
        else:
            response = lambda_client.invoke(
                FunctionName=EBS_LIFECYCLE_LAMBDA,
                InvocationType="RequestResponse",
                Payload=json.dumps({
                    "action": "create_and_attach",
                    "user_id": user_id,
                    "az": az,
                }),
            )

        payload = json.loads(response["Payload"].read())
        logger.info(f"EBS Lambda response: {json.dumps(payload)}")

        if payload.get("statusCode") != 200:
            return error_response(500, f"EBS restore failed: {payload}")

    except ClientError as e:
        logger.error(f"Failed to invoke EBS lifecycle Lambda: {e}")
        return error_response(500, f"Failed to restore volume: {e}")

    # Step 3: Update DynamoDB status to indicate ready for task start
    update_warm_resume_status(user_id)

    return success_response({
        "user_id": user_id,
        "status": "warm_resume_initiated",
        "message": "Volume restored. ECS task will start when user accesses the environment.",
    })


def schedule_shutdown(event: dict) -> dict:
    """
    Batch stop all idle containers at EOD (called at 18:00 KST).
    Excludes tasks with 'no_auto_stop' tag.
    """
    logger.info("Scheduled shutdown: stopping all idle containers")

    running_tasks = list_running_tasks()
    if not running_tasks:
        logger.info("No running tasks to stop")
        return success_response({"stopped_tasks": [], "message": "No running tasks"})

    stopped_tasks = []
    skipped_tasks = []

    for task_arn in running_tasks:
        task_info = get_task_info(task_arn)
        if not task_info:
            continue

        user_id = task_info.get("user_id", "unknown")
        task_id = task_arn.split("/")[-1]

        # Check if task has no_auto_stop tag
        if task_info.get("no_auto_stop"):
            logger.info(f"Skipping task {task_id} (user: {user_id}) - no_auto_stop tag")
            skipped_tasks.append({
                "task_arn": task_arn,
                "user_id": user_id,
                "reason": "no_auto_stop tag",
            })
            continue

        # Check if task is actively being used (high CPU in last 15 minutes)
        is_idle, _ = check_task_idle_status(task_id, user_id, period_minutes=15)
        if not is_idle:
            logger.info(f"Skipping task {task_id} (user: {user_id}) - actively in use")
            skipped_tasks.append({
                "task_arn": task_arn,
                "user_id": user_id,
                "reason": "actively_in_use",
            })
            continue

        # Trigger warm stop
        logger.info(f"Stopping task {task_id} (user: {user_id}) - scheduled shutdown")
        trigger_warm_stop(user_id, task_arn)
        stopped_tasks.append({
            "task_arn": task_arn,
            "user_id": user_id,
        })

    result = {
        "stopped_tasks": stopped_tasks,
        "skipped_tasks": skipped_tasks,
        "total_stopped": len(stopped_tasks),
        "total_skipped": len(skipped_tasks),
    }
    logger.info(f"Scheduled shutdown result: {json.dumps(result)}")

    # Send summary notification
    if SNS_TOPIC_ARN and stopped_tasks:
        try:
            sns.publish(
                TopicArn=SNS_TOPIC_ARN,
                Subject="CC-on-Bedrock: Scheduled Shutdown Summary",
                Message=json.dumps(result, indent=2),
            )
        except ClientError as e:
            logger.error(f"Failed to send SNS notification: {e}")

    return success_response(result)


# Helper functions

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
            "no_auto_stop": tags.get("no_auto_stop", "").lower() == "true",
            "started_at": task.get("startedAt"),
            "last_status": task.get("lastStatus"),
        }
    except ClientError as e:
        logger.error(f"Failed to describe task {task_arn}: {e}")
        return None


def check_task_idle_status(task_id: str, user_id: str, period_minutes: int = None, started_at: datetime = None) -> tuple:
    """
    Check if task is idle based on CloudWatch CPU metrics.
    Returns (is_idle: bool, idle_minutes: int).
    """
    if period_minutes is None:
        period_minutes = IDLE_THRESHOLD_MINUTES + 15  # Check full threshold + grace period

    # Grace period: never mark a task idle within 10 minutes of start
    if started_at:
        uptime = (datetime.utcnow() - started_at.replace(tzinfo=None)).total_seconds() / 60
        if uptime < 10:
            logger.info(f"Task {task_id} started {uptime:.0f}m ago, within grace period")
            return False, 0

    end_time = datetime.utcnow()
    start_time = end_time - timedelta(minutes=period_minutes)

    try:
        response = cloudwatch.get_metric_statistics(
            Namespace="AWS/ECS",
            MetricName="CPUUtilization",
            Dimensions=[
                {"Name": "ClusterName", "Value": CLUSTER},
                {"Name": "ServiceName", "Value": f"cc-user-{user_id}"},
            ],
            StartTime=start_time,
            EndTime=end_time,
            Period=300,  # 5 minute periods
            Statistics=["Average"],
        )

        datapoints = response.get("Datapoints", [])
        if not datapoints:
            # No metrics = fail safe, do NOT assume idle
            # Standalone tasks may not emit ServiceName-based metrics
            logger.info(f"No CPU metrics for task {task_id} (user: {user_id}), assuming NOT idle (fail safe)")
            return False, 0

        # Sort by timestamp
        datapoints.sort(key=lambda x: x["Timestamp"])

        # Check if all datapoints are below threshold
        idle_count = sum(1 for dp in datapoints if dp["Average"] < IDLE_CPU_THRESHOLD)
        total_count = len(datapoints)

        if idle_count == total_count:
            idle_minutes = idle_count * 5  # Each datapoint is 5 minutes
            return True, idle_minutes
        else:
            return False, 0

    except ClientError as e:
        logger.error(f"Failed to get CloudWatch metrics for task {task_id}: {e}")
        # On error, don't mark as idle (fail safe)
        return False, 0


def find_user_task(user_id: str) -> str | None:
    """Find running task for a user."""
    running_tasks = list_running_tasks()

    for task_arn in running_tasks:
        task_info = get_task_info(task_arn)
        if task_info and task_info.get("user_id") == user_id:
            return task_arn

    return None


def trigger_warm_stop(user_id: str, task_arn: str):
    """Trigger warm stop asynchronously."""
    try:
        lambda_client.invoke(
            FunctionName=os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "cc-on-bedrock-warm-stop"),
            InvocationType="Event",
            Payload=json.dumps({
                "action": "warm_stop",
                "user_id": user_id,
                "task_arn": task_arn,
            }),
        )
    except ClientError as e:
        logger.error(f"Failed to trigger warm stop for user {user_id}: {e}")


def update_idle_status(user_id: str, task_id: str, idle_minutes: int):
    """Update DynamoDB with idle status."""
    try:
        table.update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET idle_minutes = :im, idle_since = :is, task_id = :tid, updated_at = :ts",
            ExpressionAttributeValues={
                ":im": idle_minutes,
                ":is": (datetime.utcnow() - timedelta(minutes=idle_minutes)).isoformat(),
                ":tid": task_id,
                ":ts": datetime.utcnow().isoformat(),
            },
        )
    except ClientError as e:
        logger.error(f"Failed to update idle status for user {user_id}: {e}")


def update_warm_stop_status(user_id: str, task_id: str):
    """Update DynamoDB after warm stop."""
    try:
        table.update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET #st = :status, warm_stopped_at = :ws, task_id = :tid, updated_at = :ts",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={
                ":status": "warm_stopped",
                ":ws": datetime.utcnow().isoformat(),
                ":tid": None,
                ":ts": datetime.utcnow().isoformat(),
            },
        )
    except ClientError as e:
        logger.error(f"Failed to update warm stop status for user {user_id}: {e}")


def update_warm_resume_status(user_id: str):
    """Update DynamoDB after warm resume initiated."""
    try:
        table.update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET #st = :status, warm_resumed_at = :wr, idle_minutes = :im, updated_at = :ts",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={
                ":status": "resuming",
                ":wr": datetime.utcnow().isoformat(),
                ":im": 0,
                ":ts": datetime.utcnow().isoformat(),
            },
        )
    except ClientError as e:
        logger.error(f"Failed to update warm resume status for user {user_id}: {e}")


def get_user_volume_record(user_id: str) -> dict | None:
    """Get user's volume record from DynamoDB."""
    try:
        response = table.get_item(Key={"user_id": user_id})
        return response.get("Item")
    except ClientError as e:
        logger.error(f"DynamoDB error: {e}")
        return None


def send_idle_warning(user_id: str, idle_minutes: int):
    """Send idle warning notification via SNS."""
    if not SNS_TOPIC_ARN:
        logger.warning("SNS_TOPIC_ARN not configured, skipping notification")
        return

    try:
        message = {
            "type": "idle_warning",
            "user_id": user_id,
            "idle_minutes": idle_minutes,
            "message": f"Your development environment has been idle for {idle_minutes} minutes. "
                       f"It will be automatically stopped in 15 minutes if inactivity continues.",
            "timestamp": datetime.utcnow().isoformat(),
        }
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=f"CC-on-Bedrock: Idle Warning for {user_id}",
            Message=json.dumps(message, indent=2),
        )
        logger.info(f"Sent idle warning to user {user_id}")
    except ClientError as e:
        logger.error(f"Failed to send idle warning: {e}")


def send_warm_stop_notification(user_id: str):
    """Send warm stop notification via SNS."""
    if not SNS_TOPIC_ARN:
        logger.warning("SNS_TOPIC_ARN not configured, skipping notification")
        return

    try:
        message = {
            "type": "warm_stop",
            "user_id": user_id,
            "message": f"Your development environment has been warm-stopped due to inactivity. "
                       f"Your data has been preserved. Access the environment again to auto-resume.",
            "timestamp": datetime.utcnow().isoformat(),
        }
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=f"CC-on-Bedrock: Environment Stopped for {user_id}",
            Message=json.dumps(message, indent=2),
        )
        logger.info(f"Sent warm stop notification to user {user_id}")
    except ClientError as e:
        logger.error(f"Failed to send warm stop notification: {e}")


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
