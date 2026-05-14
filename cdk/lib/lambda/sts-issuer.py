"""
STS Issuer Lambda — Local Governance Mode (ADR-014)

Invoked by the Dashboard (`/api/local/credentials`) after NextAuth has authenticated
the user. Authentication boundary is the Lambda Function URL IAM auth: only the
Dashboard ECS task role is allowed to invoke this function. The Dashboard backend
passes verified user identity in the payload.

Behavior:
  1. Receive {sub, username, email, department, project} from Dashboard
  2. Ensure per-user IAM role exists: cc-on-bedrock-local-user-{sub_short}
     - Trust policy: only this Lambda's role can AssumeRole
     - Permission boundary: cc-on-bedrock-task-boundary (ADR-011)
     - Inline policy: Bedrock InvokeModel on allowed models + inference profile
     - Tags: username/department/project/mode=local (ADR-011 cost allocation)
  3. AssumeRole with DurationSeconds=28800 (8h), MaxSessionDuration on role = 12h
  4. Return credentials + current limit_status (from cc-on-bedrock-limits DENY#active)

Output contract (JSON):
  {
    "credentials": {
      "accessKeyId": "...",
      "secretAccessKey": "...",
      "sessionToken": "...",
      "expiration": "2026-05-12T18:00:00Z"
    },
    "profileSnippet": "[cc-bedrock]\\naws_access_key_id=...\\n...",
    "envSnippet": "export CLAUDE_CODE_USE_BEDROCK=1 AWS_PROFILE=cc-bedrock AWS_REGION=ap-northeast-2",
    "limitStatus": {
      "denyActive": false,
      "denyReason": null,
      "resetAt": null
    },
    "roleArn": "arn:aws:iam::...:role/cc-on-bedrock-local-user-{sub_short}",
    "inferenceProfileArn": "arn:..."
  }
"""
import json
import os
import time
import boto3
from botocore.exceptions import ClientError
from datetime import datetime, timezone

# Role creation / trust-policy / inline-policy helpers live in role_factory so the
# pre-provisioner Lambda (user-role-provisioner.py) reuses the exact same logic
# (ADR-022). With pre-provisioning in place, ensure_role's exists-branch runs at
# first login and AssumeRole succeeds on attempt #1.
from role_factory import ensure_role

REGION = os.environ["AWS_REGION"]
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
LIMITS_TABLE = os.environ.get("LIMITS_TABLE", "cc-on-bedrock-limits")
# AWS role chaining hard-caps assumed-role sessions at 1h whenever the caller is itself
# an assumed-role. The STS Issuer Lambda's execution role IS an assumed role, so the
# 3600s default holds; the CLI helper auto-refreshes when remaining TTL < 10min.
SESSION_DURATION_SECONDS = int(os.environ.get("SESSION_DURATION_SECONDS", "3600"))
INFERENCE_PROFILE_PREFIX = os.environ.get("INFERENCE_PROFILE_PREFIX", "cc-on-bedrock")

sts = boto3.client("sts")
ddb = boto3.resource("dynamodb")
limits_table = ddb.Table(LIMITS_TABLE)


def _get_limit_status(sub: str) -> dict:
    """Read DENY#active item from limits table."""
    try:
        resp = limits_table.get_item(Key={"PK": f"USER#{sub}", "SK": "DENY#active"})
        item = resp.get("Item")
        if not item:
            return {"denyActive": False, "denyReason": None, "resetAt": None}
        return {
            "denyActive": True,
            "denyReason": item.get("reason"),
            "resetAt": item.get("reset_at"),
            "period": item.get("period"),
        }
    except Exception as e:
        print(f"limit_status lookup failed: {e}")
        return {"denyActive": False, "denyReason": None, "resetAt": None}


def _profile_snippet(creds: dict) -> str:
    return (
        "[cc-bedrock]\n"
        f"aws_access_key_id={creds['AccessKeyId']}\n"
        f"aws_secret_access_key={creds['SecretAccessKey']}\n"
        f"aws_session_token={creds['SessionToken']}\n"
        f"region={REGION}\n"
    )


def _env_snippet() -> str:
    return (
        f"export CLAUDE_CODE_USE_BEDROCK=1 "
        f"AWS_PROFILE=cc-bedrock "
        f"AWS_REGION={REGION}"
    )


def _assume_role_with_retry(role_arn: str, session_name: str, duration: int, tags: list, max_attempts: int = 6):
    """AssumeRole with exponential backoff (1+2+4+8+16 = 31s worst case) to absorb IAM
    role propagation delay. With the ADR-022 pre-provisioner running on AdminCreateUser,
    this almost never retries; the longer budget is defense in depth for the rare case
    the event was missed or the user logs in immediately after Dashboard /api/users POST."""
    delay = 1.0
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            return sts.assume_role(
                RoleArn=role_arn,
                RoleSessionName=session_name,
                DurationSeconds=duration,
                Tags=tags,
            )
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code != "AccessDenied":
                raise
            last_exc = e
            if attempt < max_attempts - 1:
                time.sleep(delay)
                delay *= 2
    assert last_exc is not None
    raise last_exc


def handler(event, context):
    """Handle Function URL invocation (Dashboard → STS Issuer)."""
    # Function URL payload arrives via event['body']; direct invoke uses event itself
    payload = event
    body = event.get("body")
    if isinstance(body, str):
        try:
            payload = json.loads(body)
        except Exception:
            return _http(400, {"error": "invalid JSON body"})

    sub = payload.get("sub")
    username = payload.get("username") or sub
    email = payload.get("email", "")
    department = payload.get("department", "default")
    project = payload.get("project", "default")

    if not sub:
        return _http(400, {"error": "sub is required"})

    try:
        ensure_result = ensure_role(sub, username, department, project)
        role_arn = ensure_result["roleArn"]
        if ensure_result["created"]:
            # Pre-provisioner missed this user (rare; usually CloudTrail delay or
            # event filter mismatch). Sleep briefly so the retry loop has a higher
            # chance of succeeding on attempt #1.
            print(f"WARN ensure_role created role inline (pre-provisioner missed sub={sub}); sleeping 3s")
            time.sleep(3)
    except Exception as e:
        print(f"ensure_role failed: {e}")
        return _http(500, {"error": f"role provisioning failed: {e}"})

    try:
        resp = _assume_role_with_retry(
            role_arn,
            f"local-{username[:32]}",
            SESSION_DURATION_SECONDS,
            [
                {"Key": "username", "Value": username},
                {"Key": "department", "Value": department or "default"},
                {"Key": "mode", "Value": "local"},
            ],
        )
    except Exception as e:
        print(f"assume_role failed: {e}")
        return _http(500, {"error": f"AssumeRole failed: {e}"})

    creds = resp["Credentials"]
    expiration = creds["Expiration"]
    if isinstance(expiration, datetime):
        expiration = expiration.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    inference_profile_arn = (
        f"arn:aws:bedrock:{REGION}:{ACCOUNT_ID}:application-inference-profile/"
        f"{INFERENCE_PROFILE_PREFIX}-{department}"
    )

    body_out = {
        "credentials": {
            "accessKeyId": creds["AccessKeyId"],
            "secretAccessKey": creds["SecretAccessKey"],
            "sessionToken": creds["SessionToken"],
            "expiration": expiration,
        },
        "profileSnippet": _profile_snippet(creds),
        "envSnippet": _env_snippet(),
        "limitStatus": _get_limit_status(sub),
        "roleArn": role_arn,
        "inferenceProfileArn": inference_profile_arn,
        "region": REGION,
    }
    return _http(200, body_out)


def _http(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
        "body": json.dumps(body),
    }
