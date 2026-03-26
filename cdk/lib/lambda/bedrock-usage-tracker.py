"""
Bedrock Usage Tracker Lambda
Processes Bedrock Invocation Logging events from TWO sources:
  1. CloudWatch Logs Subscription (primary - has token counts)
  2. EventBridge CloudTrail events (fallback - call counts only)

DynamoDB Schema:
  PK: USER#{username}  SK: {date}#{model}
  GSI: PK starts_with DEPT# for department queries
"""
import json
import os
import gzip
import base64
import re
import boto3
from datetime import datetime
from decimal import Decimal

TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
ECS_CLUSTER = os.environ.get("ECS_CLUSTER_NAME", "cc-on-bedrock-devenv")

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
ecs_client = boto3.client("ecs")

# Bedrock pricing (ap-northeast-2, per 1M tokens)
PRICING = {
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-opus-4-6": {"input": 15.0, "output": 75.0},
    "claude-haiku-4-5": {"input": 0.80, "output": 4.0},
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0},
    "claude-opus-4-5": {"input": 15.0, "output": 75.0},
    "default": {"input": 3.0, "output": 15.0},
}

# Cache: source IP → (username, department)
_task_cache: dict = {}


def resolve_user_from_arn(identity_arn: str, source_ip: str = "") -> tuple:
    """Resolve username and department from IAM role ARN or ECS task.

    Identity ARN format for ECS tasks:
    arn:aws:sts::ACCOUNT:assumed-role/ROLE_NAME/TASK_ID
    The TASK_ID (session name) can be used to look up ECS task tags.
    """
    cache_key = identity_arn
    if cache_key in _task_cache:
        return _task_cache[cache_key]

    parts = identity_arn.split("/")
    role_name = parts[1] if len(parts) >= 2 else "unknown"
    session_name = parts[2] if len(parts) >= 3 else ""

    # If session name looks like an ECS task ID (32 hex chars), look up tags
    if len(session_name) == 32 and all(c in "0123456789abcdef" for c in session_name):
        try:
            region = os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-2")
            task_arn = f"arn:aws:ecs:{region}:{identity_arn.split(':')[4]}:task/{ECS_CLUSTER}/{session_name}"
            tasks = ecs_client.describe_tasks(
                cluster=ECS_CLUSTER, tasks=[task_arn], include=["TAGS"]
            )["tasks"]
            if tasks:
                tags = {t["key"]: t["value"] for t in tasks[0].get("tags", [])}
                user = tags.get("username", role_name)
                dept = tags.get("department", "default")
                _task_cache[cache_key] = (user, dept)
                print(f"Resolved task {session_name[:8]}... → {user}({dept})")
                return user, dept
        except Exception as e:
            print(f"ECS task lookup failed for {session_name[:8]}...: {e}")

    # Fallback: use role name
    _task_cache[cache_key] = (role_name, "default")
    return role_name, "default"


def get_model_pricing(model_id: str) -> dict:
    """Get pricing for a model ID."""
    model_lower = model_id.lower()
    for key, price in PRICING.items():
        if key in model_lower:
            return price
    return PRICING["default"]


def normalize_model(model_id: str) -> str:
    """Normalize model ID to short form."""
    result = (model_id
              .replace("global.anthropic.", "")
              .replace("apac.anthropic.", "")
              .replace("anthropic.", "")
              .split(":")[0])
    # Remove version suffix like [1m] (rstrip would strip individual chars)
    if result.endswith("[1m]"):
        result = result[:-4]
    return result


def estimate_cost(model_id: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate cost in USD."""
    pricing = get_model_pricing(model_id)
    return (input_tokens * pricing["input"] + output_tokens * pricing["output"]) / 1_000_000


def upsert_usage(username: str, department: str, date_str: str, model: str,
                 input_tokens: int, output_tokens: int, cost: float, latency_ms: int = 0):
    """Atomic upsert to DynamoDB."""
    try:
        table.update_item(
            Key={"PK": f"USER#{username}", "SK": f"{date_str}#{model}"},
            UpdateExpression=(
                "SET department = :dept, model = :model, #dt = :date, updatedAt = :now "
                "ADD inputTokens :inp, outputTokens :out, totalTokens :total, "
                "requests :one, estimatedCost :cost, latencySumMs :lat"
            ),
            ExpressionAttributeNames={"#dt": "date"},
            ExpressionAttributeValues={
                ":dept": department,
                ":model": model,
                ":date": date_str,
                ":now": datetime.utcnow().isoformat(),
                ":inp": input_tokens,
                ":out": output_tokens,
                ":total": input_tokens + output_tokens,
                ":one": 1,
                ":cost": Decimal(str(round(cost, 6))),
                ":lat": latency_ms,
            },
        )
        # Department aggregate
        table.update_item(
            Key={"PK": f"DEPT#{department}", "SK": date_str},
            UpdateExpression=(
                "SET updatedAt = :now "
                "ADD inputTokens :inp, outputTokens :out, totalTokens :total, "
                "requests :one, estimatedCost :cost, latencySumMs :lat"
            ),
            ExpressionAttributeValues={
                ":now": datetime.utcnow().isoformat(),
                ":inp": input_tokens,
                ":out": output_tokens,
                ":total": input_tokens + output_tokens,
                ":one": 1,
                ":cost": Decimal(str(round(cost, 6))),
                ":lat": latency_ms,
            },
        )
        lat_str = f" {latency_ms}ms" if latency_ms > 0 else ""
        print(f"Tracked: {username}({department}) {model} in:{input_tokens} out:{output_tokens} ${cost:.6f}{lat_str}")
    except Exception as e:
        print(f"DynamoDB error: {e}")


def process_invocation_log(log_event: dict):
    """Process a Bedrock Invocation Log entry from CloudWatch Logs."""
    message = log_event.get("message", "")
    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        return

    # Extract fields from Bedrock Invocation Log format
    model_id = data.get("modelId", "unknown")
    identity = data.get("identity", {})
    identity_arn = identity.get("arn", "")
    source_ip = data.get("sourceIPAddress", "")

    # Token counts from invocation log
    input_data = data.get("input", {})
    output_data = data.get("output", {})
    input_tokens = input_data.get("inputTokenCount", 0) or data.get("inputTokenCount", 0)
    output_tokens = output_data.get("outputTokenCount", 0) or data.get("outputTokenCount", 0)

    # Latency from output metrics
    output_body = output_data.get("outputBodyJson", {})
    latency_ms = 0
    if isinstance(output_body, dict):
        metrics = output_body.get("metrics", {})
        latency_ms = metrics.get("latencyMs", 0) or 0

    # Timestamp
    timestamp = data.get("timestamp", datetime.utcnow().isoformat())
    date_str = timestamp[:10]

    # Resolve user
    username, department = resolve_user_from_arn(identity_arn, source_ip)
    model = normalize_model(model_id)
    cost = estimate_cost(model_id, input_tokens, output_tokens)

    upsert_usage(username, department, date_str, model, input_tokens, output_tokens, cost, latency_ms)


def process_cloudtrail_event(detail: dict):
    """Process a CloudTrail Bedrock event from EventBridge (fallback, no token counts)."""
    event_name = detail.get("eventName", "")
    if event_name not in ("InvokeModel", "InvokeModelWithResponseStream", "Converse", "ConverseStream"):
        return

    source_ip = detail.get("sourceIPAddress", "")
    identity_arn = detail.get("userIdentity", {}).get("arn", "")
    event_time = detail.get("eventTime", datetime.utcnow().isoformat())
    date_str = event_time[:10]
    model_id = detail.get("requestParameters", {}).get("modelId", "unknown")

    username, department = resolve_user_from_arn(identity_arn, source_ip)
    model = normalize_model(model_id)

    # CloudTrail doesn't have token counts - just track the request
    upsert_usage(username, department, date_str, model, 0, 0, 0)


def handler(event, context):
    """Handle events from CloudWatch Logs Subscription or EventBridge."""
    processed = 0

    # Source 1: CloudWatch Logs Subscription (Bedrock Invocation Logging)
    if "awslogs" in event:
        compressed = base64.b64decode(event["awslogs"]["data"])
        log_data = json.loads(gzip.decompress(compressed))
        log_events = log_data.get("logEvents", [])
        print(f"Processing {len(log_events)} invocation log events")
        for log_event in log_events:
            process_invocation_log(log_event)
            processed += 1

    # Source 2: EventBridge (CloudTrail - fallback)
    elif "detail" in event:
        process_cloudtrail_event(event["detail"])
        processed = 1

    else:
        print(f"Unknown event format: {json.dumps(event)[:200]}")

    return {"processed": processed}
