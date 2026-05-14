"""
Token Limit Enforcer Lambda — Local Governance Mode (ADR-014, ADR-015)

Consumes the `cc-on-bedrock-usage` DynamoDB Stream (NEW_AND_OLD_IMAGES).
For each USER# update:
  1. Compute delta = NEW.tokens - OLD.tokens (per input/output)
  2. Normalize using per-model weights (Opus/Sonnet/Haiku)
  3. Atomically ADD to user × period counters (daily/weekly/monthly) in cc-on-bedrock-limits
  4. Read user limit + dept limit, compare to cumulative normalized
  5. On exceed: PutRolePolicy with deny policy + write DENY#active item + publish SNS
  6. At 80%/95%: SNS warning only (no deny)

Conditional/idempotent design:
  - Counter ADD only fires when delta > 0
  - DENY#active write uses conditional `attribute_not_exists` to avoid duplicate SNS
  - Counter items carry `ttl` set to end of period + 1 day for auto-cleanup
"""
import json
import os
import re
import boto3
from datetime import datetime, timedelta, timezone
from decimal import Decimal

REGION = os.environ["AWS_REGION"]
LIMITS_TABLE = os.environ.get("LIMITS_TABLE", "cc-on-bedrock-limits")
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
DENY_POLICY_NAME = os.environ.get("DENY_POLICY_NAME", "cc-bedrock-local-token-deny")
WARNING_THRESHOLDS = [float(x) for x in os.environ.get("WARNING_THRESHOLDS", "0.8,0.95").split(",")]

# Default normalized weights (env override possible)
DEFAULT_WEIGHTS = {
    "opus": {"in": 1.0, "out": 5.0},
    "sonnet": {"in": 0.2, "out": 1.0},
    "haiku": {"in": 0.053, "out": 0.267},
}

ROLE_PREFIX = "cc-on-bedrock-local-user-"
PERIODS = ("daily", "weekly", "monthly")

ddb = boto3.resource("dynamodb")
limits = ddb.Table(LIMITS_TABLE)
ddb_client = boto3.client("dynamodb")  # for BatchGetItem (resource API has no batch_get_item)
iam = boto3.client("iam")
sns = boto3.client("sns") if SNS_TOPIC_ARN else None

KST = timezone(timedelta(hours=9))


# ──────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────

def _model_family(model: str) -> str:
    m = (model or "").lower()
    for fam in ("opus", "sonnet", "haiku"):
        if fam in m:
            return fam
    return "sonnet"  # safe default


def _normalize(model: str, input_tokens: int, output_tokens: int, override_weights: dict | None = None) -> Decimal:
    fam = _model_family(model)
    weights = (override_weights or {}).get(fam) or DEFAULT_WEIGHTS[fam]
    raw = input_tokens * weights["in"] + output_tokens * weights["out"]
    return Decimal(str(round(raw, 4)))


def _now_kst() -> datetime:
    return datetime.now(KST)


def _bucket_for(now: datetime, period: str) -> str:
    if period == "daily":
        return now.strftime("%Y-%m-%d")
    if period == "weekly":
        iso = now.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    if period == "monthly":
        return now.strftime("%Y-%m")
    raise ValueError(period)


def _reset_at(now: datetime, period: str) -> str:
    """Compute next KST reset boundary as ISO string."""
    if period == "daily":
        nxt = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "weekly":
        # Monday 00:00 KST
        days_ahead = (7 - now.weekday()) % 7 or 7
        nxt = (now + timedelta(days=days_ahead)).replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "monthly":
        if now.month == 12:
            nxt = now.replace(year=now.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            nxt = now.replace(month=now.month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        raise ValueError(period)
    return nxt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _ttl_for(period_end_iso: str) -> int:
    end = datetime.fromisoformat(period_end_iso.replace("Z", "+00:00"))
    return int((end + timedelta(days=1)).timestamp())


def _decimal(n) -> Decimal:
    if isinstance(n, Decimal):
        return n
    return Decimal(str(n))


# ──────────────────────────────────────────────────────────
# Limit lookup
# ──────────────────────────────────────────────────────────

def _get_user_limit(sub: str, period: str, cache: dict | None = None) -> dict:
    """Look up USER#{sub}/LIMIT#{period} — cache hit avoids GetItem (review #4)."""
    if cache is not None:
        return cache.get((f"USER#{sub}", f"LIMIT#{period}"), {})
    try:
        r = limits.get_item(Key={"PK": f"USER#{sub}", "SK": f"LIMIT#{period}"})
        return r.get("Item") or {}
    except Exception as e:
        print(f"user_limit fetch failed: {e}")
        return {}


def _get_dept_limit(dept: str, period: str, cache: dict | None = None) -> dict:
    if not dept:
        return {}
    if cache is not None:
        return cache.get((f"DEPT#{dept}", f"LIMIT#{period}"), {})
    try:
        r = limits.get_item(Key={"PK": f"DEPT#{dept}", "SK": f"LIMIT#{period}"})
        return r.get("Item") or {}
    except Exception as e:
        print(f"dept_limit fetch failed: {e}")
        return {}


def _prefetch_limits(records: list) -> dict:
    """ADR-021 follow-up (review #4): one BatchGetItem per invocation instead of
    up to 6 GetItem per stream record (3 periods × USER+DEPT). Returns a dict
    keyed by (pk, sk) → item. Empty dict on failure — callers fall back to
    individual GetItem via `cache=None` path."""
    keys: set[tuple[str, str]] = set()
    for rec in records:
        new = _img_to_dict(rec.get("dynamodb", {}).get("NewImage") or {})
        pk = new.get("PK", "")
        if not pk.startswith("USER#"):
            continue
        sub = pk[len("USER#"):]
        dept = new.get("department", "")
        for period in PERIODS:
            keys.add((f"USER#{sub}", f"LIMIT#{period}"))
            if dept:
                keys.add((f"DEPT#{dept}", f"LIMIT#{period}"))
    if not keys:
        return {}
    cache: dict = {}
    keys_list = list(keys)
    while keys_list:
        chunk, keys_list = keys_list[:100], keys_list[100:]
        try:
            resp = ddb_client.batch_get_item(RequestItems={
                LIMITS_TABLE: {
                    "Keys": [{"PK": {"S": pk}, "SK": {"S": sk}} for pk, sk in chunk],
                }
            })
            for raw in resp.get("Responses", {}).get(LIMITS_TABLE, []):
                item = {k: _from_ddb(v) for k, v in raw.items()}
                cache[(item.get("PK", ""), item.get("SK", ""))] = item
        except Exception as e:
            print(f"prefetch_limits batch_get failed: {e}")
            # Continue — process_record will fall back to individual GetItem
    return cache


def _add_counter(pk: str, sk: str, delta: Decimal, ttl: int) -> Decimal:
    """Atomic ADD; returns new total."""
    r = limits.update_item(
        Key={"PK": pk, "SK": sk},
        UpdateExpression="ADD normalized :n SET #ttl = :t, updatedAt = :now",
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={
            ":n": delta,
            ":t": ttl,
            ":now": datetime.utcnow().isoformat(),
        },
        ReturnValues="UPDATED_NEW",
    )
    return _decimal(r["Attributes"]["normalized"])


# ──────────────────────────────────────────────────────────
# Deny attach
# ──────────────────────────────────────────────────────────

def _deny_policy_doc() -> str:
    return json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "TokenLimitExceededDeny",
            "Effect": "Deny",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
                "bedrock:Converse",
                "bedrock:ConverseStream",
            ],
            "Resource": "*",
        }],
    })


def _attach_deny(sub: str, reason: str, period: str, reset_at: str):
    role_name = f"{ROLE_PREFIX}{re.sub(r'[^A-Za-z0-9_-]', '-', sub)[:40]}"
    try:
        iam.put_role_policy(
            RoleName=role_name,
            PolicyName=DENY_POLICY_NAME,
            PolicyDocument=_deny_policy_doc(),
        )
        print(f"[DENY] attached {DENY_POLICY_NAME} → {role_name} ({reason})")
    except iam.exceptions.NoSuchEntityException:
        print(f"[DENY] role {role_name} not found — skipping attach")
        return False
    except Exception as e:
        print(f"[DENY] put_role_policy failed for {role_name}: {e}")
        return False

    # Conditional write: only fire SNS once per active period
    try:
        limits.put_item(
            Item={
                "PK": f"USER#{sub}",
                "SK": "DENY#active",
                "policy_name": DENY_POLICY_NAME,
                "reason": reason,
                "period": period,
                "reset_at": reset_at,
                "attached_at": datetime.utcnow().isoformat(),
            },
            ConditionExpression="attribute_not_exists(PK)",
        )
        _publish_sns(
            subject=f"[CC-on-Bedrock] Token limit exceeded ({period})",
            message=f"User {sub} exceeded {period} normalized-token limit.\nReason: {reason}\nReset at: {reset_at}",
        )
    except limits.meta.client.exceptions.ConditionalCheckFailedException:
        # already attached — silent
        pass
    return True


def _maybe_warn(sub: str, period: str, used: Decimal, limit: Decimal, who: str):
    if limit <= 0:
        return
    ratio = float(used / limit) if limit else 0.0
    for threshold in WARNING_THRESHOLDS:
        if ratio >= threshold and ratio < 1.0:
            # de-dupe via conditional put
            try:
                limits.put_item(
                    Item={
                        "PK": f"USER#{sub}",
                        "SK": f"WARN#{period}#{int(threshold*100)}",
                        "ratio": Decimal(str(round(ratio, 4))),
                        "ts": datetime.utcnow().isoformat(),
                        "ttl": _ttl_for(_reset_at(_now_kst(), period)),
                    },
                    ConditionExpression="attribute_not_exists(PK)",
                )
                _publish_sns(
                    subject=f"[CC-on-Bedrock] Token usage {int(threshold*100)}% ({period})",
                    message=f"{who} reached {int(ratio*100)}% of {period} limit.",
                )
            except limits.meta.client.exceptions.ConditionalCheckFailedException:
                pass


def _publish_sns(subject: str, message: str):
    if not sns:
        return
    try:
        sns.publish(TopicArn=SNS_TOPIC_ARN, Subject=subject, Message=message)
    except Exception as e:
        print(f"sns publish failed: {e}")


# ──────────────────────────────────────────────────────────
# Stream record processing
# ──────────────────────────────────────────────────────────

def _from_ddb(av):
    """Convert DynamoDB AttributeValue dict to plain Python type."""
    if av is None:
        return None
    if "S" in av:
        return av["S"]
    if "N" in av:
        return Decimal(av["N"])
    if "BOOL" in av:
        return av["BOOL"]
    if "NULL" in av:
        return None
    if "M" in av:
        return {k: _from_ddb(v) for k, v in av["M"].items()}
    if "L" in av:
        return [_from_ddb(v) for v in av["L"]]
    return None


def _img_to_dict(img: dict) -> dict:
    return {k: _from_ddb(v) for k, v in (img or {}).items()}


def process_record(rec: dict, limit_cache: dict | None = None):
    if rec.get("eventName") not in ("INSERT", "MODIFY"):
        return
    new = _img_to_dict(rec.get("dynamodb", {}).get("NewImage"))
    old = _img_to_dict(rec.get("dynamodb", {}).get("OldImage"))

    pk = (new or {}).get("PK", "")
    sk = (new or {}).get("SK", "")
    if not pk.startswith("USER#"):
        return  # only user-level rows; DEPT# is aggregate and would double-count
    if "#" not in sk:
        return  # not a {date}#{model} row

    sub = pk[len("USER#"):]
    model = (new or {}).get("model", "")
    dept = (new or {}).get("department", "default")

    in_new = int(new.get("inputTokens", 0) or 0)
    out_new = int(new.get("outputTokens", 0) or 0)
    in_old = int((old or {}).get("inputTokens", 0) or 0)
    out_old = int((old or {}).get("outputTokens", 0) or 0)
    d_in = max(in_new - in_old, 0)
    d_out = max(out_new - out_old, 0)
    if d_in == 0 and d_out == 0:
        return

    # User-specific weight override (LIMIT#{period} can carry weights, but optional)
    user_weight_override = None  # could load from limits if present; default OK

    delta = _normalize(model, d_in, d_out, user_weight_override)
    if delta <= 0:
        return

    now = _now_kst()
    for period in PERIODS:
        bucket = _bucket_for(now, period)
        reset_iso = _reset_at(now, period)
        ttl = _ttl_for(reset_iso)

        # increment user counter
        user_total = _add_counter(f"USER#{sub}", f"COUNTER#{period}#{bucket}", delta, ttl)
        # increment dept counter
        if dept:
            dept_total = _add_counter(f"DEPT#{dept}", f"COUNTER#{period}#{bucket}", delta, ttl)
        else:
            dept_total = Decimal("0")

        user_limit_item = _get_user_limit(sub, period, limit_cache)
        user_max = _decimal(user_limit_item.get("max_normalized", 0))
        dept_limit_item = _get_dept_limit(dept, period, limit_cache)
        dept_max = _decimal(dept_limit_item.get("max_normalized", 0))

        # Evaluate
        if user_max > 0 and user_total >= user_max:
            _attach_deny(
                sub,
                f"user {period} normalized token limit reached ({user_total}/{user_max})",
                period,
                reset_iso,
            )
            return  # stop further period processing for this record once denied
        if dept_max > 0 and dept_total >= dept_max:
            _attach_deny(
                sub,
                f"dept '{dept}' {period} normalized token limit reached ({dept_total}/{dept_max})",
                period,
                reset_iso,
            )
            return

        _maybe_warn(sub, period, user_total, user_max, f"User {sub}")
        if dept_max > 0:
            _maybe_warn(sub, period, dept_total, dept_max, f"Dept {dept}")


def handler(event, context):
    failures = []
    records = event.get("Records", [])
    # ADR-021 follow-up (review #4): one BatchGetItem instead of N+1 GetItem.
    # With batchSize=10 and 3 periods × (USER+DEPT), this collapses ~60 reads → 1.
    limit_cache = _prefetch_limits(records)
    for rec in records:
        try:
            process_record(rec, limit_cache)
        except Exception as e:
            print(f"record processing failed: {e}")
            failures.append({"itemIdentifier": rec.get("eventID")})
    return {"batchItemFailures": failures}
