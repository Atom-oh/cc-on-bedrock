"""
Bedrock Usage Tracker Lambda
Processes Bedrock Invocation Logging events from TWO sources:
  1. CloudWatch Logs Subscription (primary - has token counts + cost)
  2. EventBridge CloudTrail events (fallback - request count only, no tokens)

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
TASK_ROLE_PREFIX = "cc-on-bedrock-task-"

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
ecs_client = boto3.client("ecs")
ec2_client = boto3.client("ec2")

# Bedrock pricing (ap-northeast-2, per 1M tokens)
PRICING = {
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-opus-4-6": {"input": 15.0, "output": 75.0},
    "claude-haiku-4-5": {"input": 0.80, "output": 4.0},
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0},
    "claude-opus-4-5": {"input": 15.0, "output": 75.0},
    "default": {"input": 3.0, "output": 15.0},
}

# Cache: identity_arn → (username, department)
_task_cache: dict = {}
# Cache: subdomain → department (from EC2 instance tags)
_dept_cache: dict = {}


def _resolve_department(subdomain: str) -> str:
    """Resolve department from EC2 instance tags for a user subdomain."""
    if subdomain in _dept_cache:
        return _dept_cache[subdomain]
    try:
        resp = ec2_client.describe_instances(
            Filters=[
                {"Name": "tag:subdomain", "Values": [subdomain]},
                {"Name": "tag:managed_by", "Values": ["cc-on-bedrock"]},
            ],
            MaxResults=5,
        )
        for reservation in resp.get("Reservations", []):
            for inst in reservation.get("Instances", []):
                tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
                dept = tags.get("department", "default")
                _dept_cache[subdomain] = dept
                return dept
    except Exception as e:
        print(f"EC2 tag lookup failed for {subdomain}: {e}")
    _dept_cache[subdomain] = "default"
    return "default"


def resolve_user_from_arn(identity_arn: str, source_ip: str = "") -> tuple:
    """Resolve username and department from IAM role ARN.

    Identity ARN format:
      arn:aws:sts::ACCOUNT:assumed-role/cc-on-bedrock-task-{subdomain}/SESSION
    """
    if not identity_arn:
        return None, None

    cache_key = identity_arn
    if cache_key in _task_cache:
        return _task_cache[cache_key]

    parts = identity_arn.split("/")
    role_name = parts[1] if len(parts) >= 2 else ""

    # EC2 per-user mode: role name is cc-on-bedrock-task-{subdomain}
    if role_name.startswith(TASK_ROLE_PREFIX):
        user = role_name[len(TASK_ROLE_PREFIX):]
        dept = _resolve_department(user)
        _task_cache[cache_key] = (user, dept)
        print(f"Resolved {role_name} → {user}({dept})")
        return user, dept

    # Not a cc-on-bedrock per-user role — skip tracking
    print(f"Skipping non-user role: {role_name}")
    return None, None


def get_model_pricing(model_id: str) -> dict:
    """Get pricing for a model ID."""
    model_lower = model_id.lower()
    for key, price in PRICING.items():
        if key in model_lower:
            return price
    return PRICING["default"]


def normalize_model(model_id: str) -> str:
    """Normalize model ID to short form.

    Handles:
      - ARN: arn:aws:bedrock:region:account:inference-profile/global.anthropic.claude-sonnet-4-6-v1
      - Prefixed: global.anthropic.claude-sonnet-4-6-v1
      - Plain: claude-sonnet-4-6
    """
    if not model_id or model_id == "unknown":
        return "unknown"
    # Extract model name from ARN (split on "/" first, handles both foundation-model and inference-profile)
    if "/" in model_id:
        model_id = model_id.split("/")[-1]
    # If still looks like an ARN (starts with "arn:"), try splitting on ":" to find the model part
    if model_id.startswith("arn:"):
        # arn:aws:bedrock:region:account:resource-type:model-name
        arn_parts = model_id.split(":")
        model_id = arn_parts[-1] if len(arn_parts) > 5 else "unknown"
    # Remove region/vendor prefixes
    for prefix in ["global.anthropic.", "apac.anthropic.", "us.anthropic.", "eu.anthropic.", "anthropic."]:
        model_id = model_id.replace(prefix, "")
    # Remove colon suffix (e.g., ":0")
    model_id = model_id.split(":")[0]
    # Remove version suffixes
    if model_id.endswith("[1m]"):
        model_id = model_id[:-4]
    for suffix in ["-v1", "-v2"]:
        if model_id.endswith(suffix):
            model_id = model_id[:-len(suffix)]
            break
    return model_id or "unknown"


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

    # Resolve user — skip if not a cc-on-bedrock role
    username, department = resolve_user_from_arn(identity_arn, source_ip)
    if username is None:
        return

    model = normalize_model(model_id)
    cost = estimate_cost(model_id, input_tokens, output_tokens)

    upsert_usage(username, department, date_str, model, input_tokens, output_tokens, cost, latency_ms)


def process_cloudtrail_event(detail: dict):
    """Process a CloudTrail Bedrock event from EventBridge (fallback, no token counts)."""
    if not detail or not isinstance(detail, dict):
        print("Skipping: empty or invalid CloudTrail detail")
        return

    event_name = detail.get("eventName", "")
    if event_name not in ("InvokeModel", "InvokeModelWithResponseStream", "Converse", "ConverseStream"):
        return

    # Check for error events (requestParameters is null on errors)
    request_params = detail.get("requestParameters")
    if not request_params or not isinstance(request_params, dict):
        print(f"Skipping: no requestParameters in {event_name}")
        return

    source_ip = detail.get("sourceIPAddress", "")
    identity_arn = (detail.get("userIdentity") or {}).get("arn", "")
    event_time = detail.get("eventTime", datetime.utcnow().isoformat())
    date_str = event_time[:10]
    model_id = request_params.get("modelId", "unknown")

    username, department = resolve_user_from_arn(identity_arn, source_ip)
    if username is None:
        return

    model = normalize_model(model_id)

    # CloudTrail doesn't have token counts — track request count only
    upsert_usage(username, department, date_str, model, 0, 0, 0)


def handler(event, context):
    """Handle events from CloudWatch Logs Subscription or EventBridge."""
    processed = 0

    # Source 1: CloudWatch Logs Subscription (Bedrock Invocation Logging — primary, has tokens)
    if "awslogs" in event:
        compressed = base64.b64decode(event["awslogs"]["data"])
        log_data = json.loads(gzip.decompress(compressed))
        log_events = log_data.get("logEvents", [])
        print(f"Processing {len(log_events)} invocation log events")
        for log_event in log_events:
            try:
                process_invocation_log(log_event)
                processed += 1
            except Exception as e:
                print(f"Error processing invocation log: {e}")

    # Source 2: EventBridge CloudTrail (fallback — request count only, no tokens)
    elif "detail" in event:
        try:
            process_cloudtrail_event(event.get("detail"))
            processed = 1
        except Exception as e:
            print(f"Error processing CloudTrail event: {e}")

    else:
        print(f"Unknown event format: {json.dumps(event)[:200]}")

    return {"processed": processed}
