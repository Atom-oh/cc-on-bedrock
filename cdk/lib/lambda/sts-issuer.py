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
import re
import boto3
from datetime import datetime, timezone

REGION = os.environ["AWS_REGION"]
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
LIMITS_TABLE = os.environ.get("LIMITS_TABLE", "cc-on-bedrock-limits")
PERMISSION_BOUNDARY_NAME = os.environ.get("PERMISSION_BOUNDARY_NAME", "cc-on-bedrock-task-boundary")
ASSUMER_ROLE_ARN = os.environ["ASSUMER_ROLE_ARN"]  # this Lambda's own role ARN
SESSION_DURATION_SECONDS = int(os.environ.get("SESSION_DURATION_SECONDS", "28800"))  # 8h
MAX_SESSION_DURATION_SECONDS = int(os.environ.get("MAX_SESSION_DURATION_SECONDS", "43200"))  # 12h
# ADR-021: per-model IAM restriction removed. Model usage gating happens at runtime via
# token-limit-enforcer (ADR-014) and budget-check (ADR-015). INFERENCE_PROFILE_PREFIX is
# only used for the informational `inferenceProfileArn` field in the response.
INFERENCE_PROFILE_PREFIX = os.environ.get("INFERENCE_PROFILE_PREFIX", "cc-on-bedrock")

iam = boto3.client("iam")
sts = boto3.client("sts")
ddb = boto3.resource("dynamodb")
limits_table = ddb.Table(LIMITS_TABLE)

ROLE_PREFIX = "cc-on-bedrock-local-user-"


def _sub_to_role_suffix(sub: str) -> str:
    """Cognito sub (UUID) → IAM-safe short suffix.
    IAM role names allow [A-Za-z0-9+=,.@_-], max 64 chars. We keep dashes
    and take the full sub to ensure uniqueness."""
    safe = re.sub(r"[^A-Za-z0-9_-]", "-", sub)
    return safe[:48]  # ROLE_PREFIX(24) + 48 = 72 → trim to 40 to keep total <= 64
    # actually ROLE_PREFIX is 24 chars, so 64-24=40 budget. Trim:


def _role_name(sub: str) -> str:
    suffix = re.sub(r"[^A-Za-z0-9_-]", "-", sub)[:40]
    return f"{ROLE_PREFIX}{suffix}"


def _allowed_model_arns():
    """ADR-021: wildcard ARNs covering all Claude-family models across every region prefix
    (anthropic.*, global.anthropic.*, us.anthropic.*, apac.anthropic.*, eu.anthropic.*).
    Per-model spend gating is delegated to token-limit-enforcer (ADR-014) + budget-check (ADR-015).
    """
    return [
        "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
        f"arn:aws:bedrock:*:{ACCOUNT_ID}:inference-profile/*anthropic.claude-*",
        f"arn:aws:bedrock:*:{ACCOUNT_ID}:application-inference-profile/*",
    ]


def _trust_policy() -> dict:
    # NOTE: sts:TagSession is required because we call AssumeRole with Tags=[...].
    # Without it, AWS rejects with AccessDenied even when the principal is allowed
    # to AssumeRole — both actions must be present in the trust policy.
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"AWS": ASSUMER_ROLE_ARN},
            "Action": ["sts:AssumeRole", "sts:TagSession"],
        }],
    }


def _inline_policy(department: str) -> dict:
    """Bedrock InvokeModel on all Claude models (ADR-021) + read-only Bedrock metadata.
    `department` is preserved for role tagging / future hooks but no longer narrows the policy."""
    del department  # unused since ADR-021 — kept in signature for caller compatibility
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "BedrockInvoke",
                "Effect": "Allow",
                "Action": [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                    "bedrock:Converse",
                    "bedrock:ConverseStream",
                ],
                "Resource": _allowed_model_arns(),
            },
            {
                "Sid": "BedrockListReadOnly",
                "Effect": "Allow",
                "Action": [
                    "bedrock:ListFoundationModels",
                    "bedrock:ListInferenceProfiles",
                    "bedrock:GetInferenceProfile",
                ],
                "Resource": "*",
            },
        ],
    }


def _ensure_role(sub: str, username: str, department: str, project: str) -> str:
    """Create or update the per-user role; returns role ARN."""
    role_name = _role_name(sub)
    tags = [
        {"Key": "username", "Value": username},
        {"Key": "department", "Value": department or "default"},
        {"Key": "project", "Value": project or "default"},
        {"Key": "mode", "Value": "local"},
        {"Key": "managed_by", "Value": "cc-on-bedrock"},
    ]
    try:
        iam.get_role(RoleName=role_name)
        # exists — update trust, inline policy, tags
        iam.update_assume_role_policy(
            RoleName=role_name,
            PolicyDocument=json.dumps(_trust_policy()),
        )
        iam.tag_role(RoleName=role_name, Tags=tags)
    except iam.exceptions.NoSuchEntityException:
        iam.create_role(
            RoleName=role_name,
            AssumeRolePolicyDocument=json.dumps(_trust_policy()),
            MaxSessionDuration=MAX_SESSION_DURATION_SECONDS,
            PermissionsBoundary=f"arn:aws:iam::{ACCOUNT_ID}:policy/{PERMISSION_BOUNDARY_NAME}",
            Tags=tags,
            Description=f"CC-on-Bedrock Local Governance role for {username} ({department})",
        )
        # IAM eventual consistency: small wait before AssumeRole
        import time
        time.sleep(8)

    iam.put_role_policy(
        RoleName=role_name,
        PolicyName="BedrockInvokeInline",
        PolicyDocument=json.dumps(_inline_policy(department)),
    )
    return f"arn:aws:iam::{ACCOUNT_ID}:role/{role_name}"


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
        role_arn = _ensure_role(sub, username, department, project)
    except Exception as e:
        print(f"ensure_role failed: {e}")
        return _http(500, {"error": f"role provisioning failed: {e}"})

    try:
        resp = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName=f"local-{username[:32]}",
            DurationSeconds=SESSION_DURATION_SECONDS,
            Tags=[
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
