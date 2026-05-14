"""
Shared role-factory helpers for Local Governance Mode (ADR-014).

Used by:
  - sts-issuer.py        — lazy fallback when a role is missing at AssumeRole time
  - user-role-provisioner.py — pre-provisioning triggered by CloudTrail/EventBridge
    when a Cognito user is created (eliminates the IAM-propagation race at first login)

Module name has no hyphen so it imports cleanly from sibling Lambda code.
"""
import json
import os
import re
import boto3

ACCOUNT_ID = os.environ["ACCOUNT_ID"]
PERMISSION_BOUNDARY_NAME = os.environ.get("PERMISSION_BOUNDARY_NAME", "cc-on-bedrock-task-boundary")
ASSUMER_ROLE_ARN = os.environ["ASSUMER_ROLE_ARN"]
MAX_SESSION_DURATION_SECONDS = int(os.environ.get("MAX_SESSION_DURATION_SECONDS", "3600"))

ROLE_PREFIX = "cc-on-bedrock-local-user-"

iam = boto3.client("iam")


def role_name(sub: str) -> str:
    """Cognito sub (UUID) -> IAM-safe role name. IAM allows [A-Za-z0-9+=,.@_-], max 64 chars.
    ROLE_PREFIX is 24 chars, so 40-char budget for the suffix."""
    suffix = re.sub(r"[^A-Za-z0-9_-]", "-", sub)[:40]
    return f"{ROLE_PREFIX}{suffix}"


def allowed_model_arns() -> list:
    """ADR-021 wildcard Claude-family ARNs across every region prefix."""
    return [
        "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
        f"arn:aws:bedrock:*:{ACCOUNT_ID}:inference-profile/*anthropic.claude-*",
        f"arn:aws:bedrock:*:{ACCOUNT_ID}:application-inference-profile/*",
    ]


def trust_policy() -> dict:
    # sts:TagSession is required because AssumeRole is called with Tags=[...].
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"AWS": ASSUMER_ROLE_ARN},
            "Action": ["sts:AssumeRole", "sts:TagSession"],
        }],
    }


def inline_policy(department: str) -> dict:
    """Bedrock InvokeModel on all Claude models (ADR-021) + read-only metadata."""
    del department  # unused since ADR-021 — kept in signature for compatibility
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
                "Resource": allowed_model_arns(),
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


def ensure_role(sub: str, username: str, department: str, project: str) -> dict:
    """Create or refresh the per-user role. Idempotent.

    Returns a dict: {"roleArn": "...", "created": bool}
      - created=True means CreateRole was just called — caller may want to delay AssumeRole
      - created=False means the role already existed (trust + inline policy refreshed)
    """
    name = role_name(sub)
    tags = [
        {"Key": "username", "Value": username},
        {"Key": "department", "Value": department or "default"},
        {"Key": "project", "Value": project or "default"},
        {"Key": "mode", "Value": "local"},
        {"Key": "managed_by", "Value": "cc-on-bedrock"},
    ]
    created = False
    try:
        iam.get_role(RoleName=name)
        iam.update_assume_role_policy(
            RoleName=name,
            PolicyDocument=json.dumps(trust_policy()),
        )
        iam.tag_role(RoleName=name, Tags=tags)
    except iam.exceptions.NoSuchEntityException:
        iam.create_role(
            RoleName=name,
            AssumeRolePolicyDocument=json.dumps(trust_policy()),
            MaxSessionDuration=MAX_SESSION_DURATION_SECONDS,
            PermissionsBoundary=f"arn:aws:iam::{ACCOUNT_ID}:policy/{PERMISSION_BOUNDARY_NAME}",
            Tags=tags,
            Description=f"CC-on-Bedrock Local Governance role for {username} ({department})",
        )
        created = True

    iam.put_role_policy(
        RoleName=name,
        PolicyName="BedrockInvokeInline",
        PolicyDocument=json.dumps(inline_policy(department)),
    )
    return {"roleArn": f"arn:aws:iam::{ACCOUNT_ID}:role/{name}", "created": created}
