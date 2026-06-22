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


def derive_subdomain(email_or_username: str) -> str:
    """Email local-part -> canonical subdomain (ADR-031). Shared by the provisioner
    and sts-issuer so both build the same IAM role name. [a-z0-9-], 3-30 chars.
    Raises ValueError if the sanitized result is < 3 chars (no shared-role pad)."""
    local = (email_or_username or "").split("@")[0].lower()
    cleaned = re.sub(r"[^a-z0-9-]", "-", local)
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    truncated = cleaned[:30].rstrip("-")
    if len(truncated) < 3:
        raise ValueError(
            f"cannot derive subdomain from {email_or_username!r}: "
            f"sanitized {truncated!r} (must be >= 3 chars, end alphanumeric)"
        )
    return truncated


def role_name(subdomain: str) -> str:
    """subdomain -> IAM-safe Local Governance role name (ADR-031 B′).

    The canonical resource name is the subdomain (= readable email id, derived by
    user-role-provisioner.derive_subdomain, [a-z0-9-] 3-30 chars). IAM role names
    allow [A-Za-z0-9+=,.@_-], max 64; ROLE_PREFIX is 25 chars so a ≤30-char
    subdomain fits comfortably. (Previously keyed by Cognito sub UUID — ADR-025.)
    """
    suffix = re.sub(r"[^A-Za-z0-9_-]", "-", subdomain or "")[:38]
    return f"{ROLE_PREFIX}{suffix}"


def allowed_model_arns() -> list:
    """ADR-021 wildcard Claude-family ARNs across every region prefix."""
    return [
        "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
        f"arn:aws:bedrock:*:{ACCOUNT_ID}:inference-profile/*anthropic.claude-*",
        "arn:aws:bedrock:*::foundation-model/*embed*",
        f"arn:aws:bedrock:*:{ACCOUNT_ID}:inference-profile/*embed*",
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


def ensure_role(subdomain: str, email: str, department: str, project: str) -> dict:
    """Create or refresh the per-user Local Governance role. Idempotent.

    ADR-031 (B′): the role is named by `subdomain` (cc-on-bedrock-local-user-
    {subdomain}) and tagged with `email` (the canonical key) + `subdomain`.
    Collision guard: if a role of this name already exists owned by a DIFFERENT
    email, raise — two users must never share one Local role (subdomain uniqueness
    invariant). The provisioner disambiguates colliding subdomains before calling.

    Returns {"roleArn": "...", "created": bool}.
    """
    name = role_name(subdomain)
    email_l = (email or "").strip().lower()
    tags = [
        {"Key": "email", "Value": email_l},
        {"Key": "subdomain", "Value": subdomain},
        {"Key": "username", "Value": email_l},  # back-compat (legacy readers)
        {"Key": "department", "Value": department or "default"},
        {"Key": "project", "Value": project or "default"},
        {"Key": "mode", "Value": "local"},
        {"Key": "managed_by", "Value": "cc-on-bedrock"},
    ]
    created = False
    try:
        iam.get_role(RoleName=name)
        # Uniqueness/collision guard: a pre-existing role owned by a different
        # email means two users derived the same subdomain — refuse rather than
        # hand the second user the first user's identity.
        existing = iam.list_role_tags(RoleName=name).get("Tags", [])
        existing_email = next(
            (t["Value"].strip().lower() for t in existing if t["Key"] in ("email", "username")),
            "",
        )
        if existing_email and email_l and existing_email != email_l:
            raise RuntimeError(
                f"subdomain collision on {name}: role owned by {existing_email!r} "
                f"but ensure_role invoked for {email_l!r}. Two users derived the same "
                f"subdomain — provisioner must disambiguate (suffix) before calling."
            )
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
            Description=f"CC-on-Bedrock Local Governance role for {email_l} ({department})",
        )
        created = True

    iam.put_role_policy(
        RoleName=name,
        PolicyName="BedrockInvokeInline",
        PolicyDocument=json.dumps(inline_policy(department)),
    )
    return {"roleArn": f"arn:aws:iam::{ACCOUNT_ID}:role/{name}", "created": created}
