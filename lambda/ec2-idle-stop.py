"""
EC2 Idle Stop Lambda for CC-on-Bedrock (EC2-per-user mode)
Triggered by: EventBridge scheduled rule (every 5 min)

Much simpler than warm-stop.py (ECS mode):
- No snapshot/restore (EC2 Stop preserves EBS)
- No volume management
- Just check CloudWatch metrics → StopInstances

Actions:
- check_idle: Scan running EC2 devenv instances, stop idle ones
- schedule_shutdown: Batch stop all instances at EOD (18:00 KST)
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ.get("REGION", "ap-northeast-2")
IDLE_THRESHOLD_MINUTES = int(os.environ.get("IDLE_THRESHOLD_MINUTES", "30"))
IDLE_CPU_THRESHOLD = 5.0  # percent
IDLE_NETWORK_THRESHOLD = 1000  # bytes/sec
INSTANCE_TABLE = os.environ.get("INSTANCE_TABLE", "cc-user-instances")
ROUTING_TABLE = os.environ.get("ROUTING_TABLE", "cc-routing-table")
USAGE_TABLE = os.environ.get("USAGE_TABLE", "cc-on-bedrock-usage")
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
EOD_SHUTDOWN_ENABLED = os.environ.get("EOD_SHUTDOWN_ENABLED", "true")
HIBERNATE_ENABLED = os.environ.get("HIBERNATE_ENABLED", "false").lower() == "true"
HIBERNATE_MAX_DAYS = 55  # AWS limit is 60 days; rotate at 55 for safety

ec2 = boto3.client("ec2", region_name=REGION)
cloudwatch = boto3.client("cloudwatch", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION)
sns = boto3.client("sns", region_name=REGION)

table = dynamodb.Table(INSTANCE_TABLE)


def handler(event: dict, context: Any) -> dict:
    logger.info(f"Received event: {json.dumps(event)}")
    action = event.get("action", "check_idle")

    try:
        if action == "check_idle":
            return check_idle()
        elif action == "schedule_shutdown":
            return schedule_shutdown()
        elif action == "check_hibernate_expiry":
            return check_hibernate_expiry(context)
        else:
            return {"statusCode": 400, "body": f"Unknown action: {action}"}
    except Exception as e:
        logger.error(f"Error: {e}")
        return {"statusCode": 500, "body": str(e)}


def check_idle() -> dict:
    """Check all running devenv instances for idle status."""
    instances = get_running_instances()
    if not instances:
        return {"statusCode": 200, "body": {"checked": 0}}

    stopped = []
    warned = []

    for inst in instances:
        instance_id = inst["InstanceId"]
        subdomain = get_tag(inst, "subdomain")
        launch_time = inst.get("LaunchTime")

        # Grace period: 10 min after launch
        if launch_time:
            uptime_min = (datetime.now(timezone.utc) - launch_time).total_seconds() / 60
            if uptime_min < 10:
                continue

        # Check keep_alive_until
        if is_keep_alive_active(subdomain):
            continue

        idle_minutes = get_idle_minutes(instance_id, subdomain)

        if idle_minutes >= IDLE_THRESHOLD_MINUTES + 15:
            # 45+ min idle → stop
            logger.info(f"Stopping idle instance {instance_id} ({subdomain}), idle {idle_minutes}m")
            stop_devenv_instance(instance_id, subdomain)
            stopped.append({"instanceId": instance_id, "subdomain": subdomain, "idle_minutes": idle_minutes})

        elif idle_minutes >= IDLE_THRESHOLD_MINUTES:
            # 30+ min idle → warn
            logger.info(f"Warning: instance {instance_id} ({subdomain}) idle {idle_minutes}m")
            send_warning(subdomain, idle_minutes)
            warned.append({"instanceId": instance_id, "subdomain": subdomain, "idle_minutes": idle_minutes})

    return {"statusCode": 200, "body": {"stopped": stopped, "warned": warned}}


def schedule_shutdown() -> dict:
    """EOD batch shutdown of all running devenv instances."""
    if EOD_SHUTDOWN_ENABLED.lower() != "true":
        return {"statusCode": 200, "body": {"message": "EOD shutdown disabled"}}

    instances = get_running_instances()
    stopped = []
    skipped = []

    for inst in instances:
        instance_id = inst["InstanceId"]
        subdomain = get_tag(inst, "subdomain")

        # Skip if no_auto_stop tag
        if get_tag(inst, "no_auto_stop").lower() == "true":
            skipped.append({"instanceId": instance_id, "reason": "no_auto_stop"})
            continue

        # Skip if keep-alive active
        if is_keep_alive_active(subdomain):
            skipped.append({"instanceId": instance_id, "reason": "keep_alive"})
            continue

        # Skip if actively used (last 15 min)
        idle_minutes = get_idle_minutes(instance_id, subdomain, period_minutes=15)
        if idle_minutes < 15:
            skipped.append({"instanceId": instance_id, "reason": "active"})
            continue

        stop_devenv_instance(instance_id, subdomain)
        stopped.append({"instanceId": instance_id, "subdomain": subdomain})

    result = {"stopped": stopped, "skipped": skipped}
    logger.info(f"EOD shutdown: {json.dumps(result)}")

    if SNS_TOPIC_ARN and stopped:
        try:
            sns.publish(
                TopicArn=SNS_TOPIC_ARN,
                Subject="CC-on-Bedrock: EOD Shutdown Summary",
                Message=json.dumps(result, indent=2),
            )
        except ClientError as e:
            logger.error(f"SNS publish failed: {e}")

    return {"statusCode": 200, "body": result}


# ─── Helpers ───

def get_running_instances() -> list:
    """Get all running CC-on-Bedrock devenv instances."""
    result = ec2.describe_instances(
        Filters=[
            {"Name": "tag:managed_by", "Values": ["cc-on-bedrock"]},
            {"Name": "tag:subdomain", "Values": ["*"]},
            {"Name": "instance-state-name", "Values": ["running"]},
        ],
    )
    instances = []
    for reservation in result.get("Reservations", []):
        instances.extend(reservation.get("Instances", []))
    return instances


def get_tag(instance: dict, key: str) -> str:
    for tag in instance.get("Tags", []):
        if tag["Key"] == key:
            return tag["Value"]
    return ""


def get_idle_minutes(instance_id: str, subdomain: str, period_minutes: int = None) -> int:
    """Check CPU + Network metrics to determine idle duration."""
    if period_minutes is None:
        period_minutes = IDLE_THRESHOLD_MINUTES + 15

    end_time = datetime.utcnow()
    start_time = end_time - timedelta(minutes=period_minutes)

    # CPU check
    try:
        cpu_resp = cloudwatch.get_metric_statistics(
            Namespace="AWS/EC2",
            MetricName="CPUUtilization",
            Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
            StartTime=start_time, EndTime=end_time,
            Period=300, Statistics=["Average"],
        )
        cpu_dps = cpu_resp.get("Datapoints", [])
        if not cpu_dps:
            return 0  # No data → not idle (fail safe)

        cpu_idle_count = sum(1 for dp in cpu_dps if dp["Average"] < IDLE_CPU_THRESHOLD)
        if cpu_idle_count < len(cpu_dps):
            return 0  # CPU active
    except ClientError:
        return 0  # Fail safe

    # Network check
    try:
        for metric in ["NetworkIn", "NetworkOut"]:
            net_resp = cloudwatch.get_metric_statistics(
                Namespace="AWS/EC2",
                MetricName=metric,
                Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
                StartTime=start_time, EndTime=end_time,
                Period=300, Statistics=["Average"],
            )
            net_dps = net_resp.get("Datapoints", [])
            if net_dps:
                avg_bytes_sec = sum(dp["Average"] for dp in net_dps) / len(net_dps) / 300
                if avg_bytes_sec >= IDLE_NETWORK_THRESHOLD:
                    return 0  # Network active
    except ClientError:
        return 0  # Fail safe

    # Token usage check
    if has_recent_token_usage(subdomain):
        return 0

    return cpu_idle_count * 5  # Each datapoint is 5 min


def has_recent_token_usage(subdomain: str, minutes: int = 15) -> bool:
    """Check Bedrock API usage in the last N minutes."""
    try:
        usage_table = dynamodb.Table(USAGE_TABLE)
        cutoff = (datetime.utcnow() - timedelta(minutes=minutes)).isoformat() + "Z"
        resp = usage_table.query(
            KeyConditionExpression="PK = :pk AND SK > :cutoff",
            ExpressionAttributeValues={":pk": f"USER#{subdomain}", ":cutoff": cutoff},
            Limit=1,
        )
        return len(resp.get("Items", [])) > 0
    except Exception:
        return True  # Fail safe


def is_keep_alive_active(subdomain: str) -> bool:
    """Check if user has active keep-alive."""
    try:
        result = table.get_item(Key={"user_id": subdomain})
        keep_until = result.get("Item", {}).get("keep_alive_until", "")
        if keep_until:
            ka_time = datetime.fromisoformat(keep_until.replace("Z", "+00:00"))
            return ka_time > datetime.now(timezone.utc)
    except Exception:
        pass
    return False


def stop_devenv_instance(instance_id: str, subdomain: str):
    """Stop (or hibernate) instance and deregister route."""
    # Deregister Nginx route
    try:
        routing = dynamodb.Table(ROUTING_TABLE)
        routing.delete_item(Key={"subdomain": subdomain})
    except Exception as e:
        logger.warning(f"Route deregister failed for {subdomain}: {e}")

    # ADR-010: Hibernate if enabled and instance supports it
    should_hibernate = False
    if HIBERNATE_ENABLED:
        try:
            desc = ec2.describe_instances(InstanceIds=[instance_id])
            should_hibernate = desc["Reservations"][0]["Instances"][0].get(
                "HibernationOptions", {}).get("Configured", False)
        except Exception:
            should_hibernate = False

    try:
        ec2.stop_instances(InstanceIds=[instance_id], Hibernate=should_hibernate)
    except ClientError as e:
        if should_hibernate:
            logger.warning(f"Hibernate failed for {instance_id}, falling back to stop: {e}")
            ec2.stop_instances(InstanceIds=[instance_id])
            should_hibernate = False
        else:
            raise

    # Update DynamoDB
    status = "hibernated" if should_hibernate else "stopped"
    try:
        update_expr = "SET #st = :status, updatedAt = :ts"
        expr_values = {
            ":status": status,
            ":ts": datetime.utcnow().isoformat(),
        }
        if should_hibernate:
            update_expr += ", hibernatedAt = :hat"
            expr_values[":hat"] = datetime.utcnow().isoformat()
        table.update_item(
            Key={"user_id": subdomain},
            UpdateExpression=update_expr,
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues=expr_values,
        )
    except Exception as e:
        logger.warning(f"DynamoDB update failed for {subdomain}: {e}")


def check_hibernate_expiry(context=None) -> dict:
    """Rotate instances hibernated > HIBERNATE_MAX_DAYS to avoid AWS 60-day limit.

    Scans DynamoDB for status=hibernated with hibernatedAt older than HIBERNATE_MAX_DAYS.
    For each: Start → wait for running → Re-Hibernate → update hibernatedAt.
    Processes max 2 instances per invocation to stay within Lambda timeout.
    """
    if not HIBERNATE_ENABLED:
        return {"statusCode": 200, "body": {"message": "Hibernate disabled"}}

    cutoff = (datetime.utcnow() - timedelta(days=HIBERNATE_MAX_DAYS)).isoformat()
    rotated = []
    errors = []
    max_per_invocation = 2  # Each rotation takes ~2min; stay within 5min timeout

    # Paginated scan for hibernated instances past expiry
    items = []
    scan_kwargs = {
        "FilterExpression": "#st = :status AND hibernatedAt < :cutoff",
        "ExpressionAttributeNames": {"#st": "status"},
        "ExpressionAttributeValues": {":status": "hibernated", ":cutoff": cutoff},
    }
    try:
        while True:
            resp = table.scan(**scan_kwargs)
            items.extend(resp.get("Items", []))
            if "LastEvaluatedKey" not in resp:
                break
            scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    except Exception as e:
        logger.error(f"DynamoDB scan failed: {e}")
        return {"statusCode": 500, "body": str(e)}

    for item in items[:max_per_invocation]:
        subdomain = item["user_id"]
        instance_id = item.get("instanceId", "")
        if not instance_id:
            continue

        # Check remaining Lambda time before starting a ~2min rotation
        if context and hasattr(context, "get_remaining_time_in_millis"):
            remaining_ms = context.get_remaining_time_in_millis()
            if remaining_ms < 150_000:  # Need at least 2.5min
                logger.warning(f"Skipping {instance_id}: only {remaining_ms}ms remaining")
                break

        try:
            # Mark transitional state so crash doesn't leave ghost
            table.update_item(
                Key={"user_id": subdomain},
                UpdateExpression="SET #st = :rotating, updatedAt = :ts",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={
                    ":rotating": "rotating",
                    ":ts": datetime.utcnow().isoformat(),
                },
            )

            # Start instance (resume from hibernate)
            logger.info(f"Rotating hibernated instance {instance_id} ({subdomain})")
            ec2.start_instances(InstanceIds=[instance_id])

            # Wait for running state (up to 2 min)
            waiter = ec2.get_waiter("instance_running")
            waiter.wait(InstanceIds=[instance_id], WaiterConfig={"Delay": 10, "MaxAttempts": 12})

            # Re-hibernate
            ec2.stop_instances(InstanceIds=[instance_id], Hibernate=True)

            # Update hibernatedAt + restore status
            table.update_item(
                Key={"user_id": subdomain},
                UpdateExpression="SET #st = :status, hibernatedAt = :hat, updatedAt = :ts",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={
                    ":status": "hibernated",
                    ":hat": datetime.utcnow().isoformat(),
                    ":ts": datetime.utcnow().isoformat(),
                },
            )
            rotated.append({"instanceId": instance_id, "subdomain": subdomain})
        except Exception as e:
            logger.error(f"Rotation failed for {instance_id} ({subdomain}): {e}")
            # Revert to hibernated on failure (instance may still be running — next idle-check handles it)
            try:
                table.update_item(
                    Key={"user_id": subdomain},
                    UpdateExpression="SET #st = :status, updatedAt = :ts",
                    ExpressionAttributeNames={"#st": "status"},
                    ExpressionAttributeValues={
                        ":status": "hibernated",
                        ":ts": datetime.utcnow().isoformat(),
                    },
                )
            except Exception:
                pass
            errors.append({"instanceId": instance_id, "subdomain": subdomain, "error": str(e)})

    skipped = len(items) - max_per_invocation if len(items) > max_per_invocation else 0
    result = {"rotated": rotated, "errors": errors, "skipped": skipped, "total": len(items)}
    logger.info(f"Hibernate rotation: {json.dumps(result)}")
    return {"statusCode": 200, "body": result}


def send_warning(subdomain: str, idle_minutes: int):
    """Send idle warning via SNS."""
    if not SNS_TOPIC_ARN:
        return
    try:
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=f"CC-on-Bedrock: Idle Warning ({subdomain})",
            Message=f"Instance for {subdomain} has been idle for {idle_minutes} minutes. "
                    f"It will be stopped after {IDLE_THRESHOLD_MINUTES + 15} minutes.",
        )
    except ClientError as e:
        logger.error(f"SNS warning failed: {e}")
