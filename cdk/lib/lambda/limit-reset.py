"""
Limit Reset Lambda — Local Governance Mode (ADR-014, ADR-015)

Triggered by EventBridge cron at KST period boundaries:
  daily   : 15:00 UTC every day      ( == 00:00 KST next day )
  weekly  : 15:00 UTC every Sunday   ( == Mon 00:00 KST )
  monthly : 15:00 UTC last day of month ( == 1st 00:00 KST )

For the period passed via event['period']:
  1. Scan limits table for `DENY#active` items whose `period` field matches
  2. For each matching user: DeleteRolePolicy + delete DENY#active
  3. Delete completed COUNTER#{period}#{old_bucket} items (best-effort; TTL also cleans them)
  4. Delete WARN# items for that period
  5. Publish SNS summary
"""
import json
import os
import re
import boto3
from datetime import datetime, timedelta, timezone

REGION = os.environ["AWS_REGION"]
LIMITS_TABLE = os.environ.get("LIMITS_TABLE", "cc-on-bedrock-limits")
DENY_POLICY_NAME = os.environ.get("DENY_POLICY_NAME", "cc-bedrock-local-token-deny")
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
ROLE_PREFIX = "cc-on-bedrock-local-user-"

ddb = boto3.resource("dynamodb")
limits = ddb.Table(LIMITS_TABLE)
iam = boto3.client("iam")
sns = boto3.client("sns") if SNS_TOPIC_ARN else None

KST = timezone(timedelta(hours=9))


def _role_name(sub: str) -> str:
    return f"{ROLE_PREFIX}{re.sub(r'[^A-Za-z0-9_-]', '-', sub)[:40]}"


def _detach(sub: str) -> bool:
    role = _role_name(sub)
    try:
        iam.delete_role_policy(RoleName=role, PolicyName=DENY_POLICY_NAME)
        print(f"[RESET] detached {DENY_POLICY_NAME} from {role}")
        return True
    except iam.exceptions.NoSuchEntityException:
        return False
    except Exception as e:
        print(f"[RESET] detach failed for {role}: {e}")
        return False


def _scan_deny_active(period: str):
    """Yield DENY#active items matching this period."""
    last = None
    while True:
        kwargs = {
            "FilterExpression": "SK = :sk AND #p = :period",
            "ExpressionAttributeNames": {"#p": "period"},
            "ExpressionAttributeValues": {":sk": "DENY#active", ":period": period},
        }
        if last:
            kwargs["ExclusiveStartKey"] = last
        r = limits.scan(**kwargs)
        for it in r.get("Items", []):
            yield it
        last = r.get("LastEvaluatedKey")
        if not last:
            return


def _scan_warn(period: str):
    last = None
    prefix = f"WARN#{period}#"
    while True:
        kwargs = {
            "FilterExpression": "begins_with(SK, :p)",
            "ExpressionAttributeValues": {":p": prefix},
        }
        if last:
            kwargs["ExclusiveStartKey"] = last
        r = limits.scan(**kwargs)
        for it in r.get("Items", []):
            yield it
        last = r.get("LastEvaluatedKey")
        if not last:
            return


def _previous_bucket(period: str) -> str:
    """The bucket id that just closed (KST)."""
    now = datetime.now(KST)
    if period == "daily":
        prev = now - timedelta(days=1)
        return prev.strftime("%Y-%m-%d")
    if period == "weekly":
        prev = now - timedelta(days=7)
        iso = prev.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    if period == "monthly":
        if now.month == 1:
            return f"{now.year - 1}-12"
        return f"{now.year}-{now.month - 1:02d}"
    raise ValueError(period)


def _delete_counters(period: str, bucket: str):
    """Delete COUNTER#{period}#{bucket} items table-wide."""
    last = None
    sk = f"COUNTER#{period}#{bucket}"
    deleted = 0
    while True:
        kwargs = {
            "FilterExpression": "SK = :sk",
            "ExpressionAttributeValues": {":sk": sk},
        }
        if last:
            kwargs["ExclusiveStartKey"] = last
        r = limits.scan(**kwargs)
        with limits.batch_writer() as bw:
            for it in r.get("Items", []):
                bw.delete_item(Key={"PK": it["PK"], "SK": it["SK"]})
                deleted += 1
        last = r.get("LastEvaluatedKey")
        if not last:
            break
    return deleted


def _notify(period: str, detached: int, counters_deleted: int):
    if not sns:
        return
    try:
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=f"[CC-on-Bedrock] {period} token-limit reset",
            Message=(
                f"Reset {period} limits\n"
                f"  Deny policies detached: {detached}\n"
                f"  Counter rows deleted: {counters_deleted}\n"
                f"  Timestamp: {datetime.utcnow().isoformat()}Z\n"
            ),
        )
    except Exception as e:
        print(f"sns publish failed: {e}")


def handler(event, context):
    period = (event or {}).get("period")
    if period not in ("daily", "weekly", "monthly"):
        return {"error": f"invalid period: {period}"}

    detached = 0
    for item in _scan_deny_active(period):
        sub = item["PK"][len("USER#"):]
        if _detach(sub):
            detached += 1
        try:
            limits.delete_item(Key={"PK": item["PK"], "SK": "DENY#active"})
        except Exception as e:
            print(f"[RESET] delete DENY#active failed for {sub}: {e}")

    bucket = _previous_bucket(period)
    counters = _delete_counters(period, bucket)

    # Clean warn flags
    warn_cleared = 0
    for item in _scan_warn(period):
        try:
            limits.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
            warn_cleared += 1
        except Exception as e:
            print(f"[RESET] warn delete failed: {e}")

    _notify(period, detached, counters)
    return {
        "period": period,
        "bucket_cleared": bucket,
        "detached": detached,
        "counters_deleted": counters,
        "warn_cleared": warn_cleared,
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }
