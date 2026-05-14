"""
User Role Provisioner Lambda — Local Governance Mode + EC2 mode pre-provisioning (ADR-022).

Single source of truth for everything that must exist when a Cognito user is born:

  Triggered by EventBridge on CloudTrail management events:
    eventSource = cognito-idp.amazonaws.com
    eventName   ∈ {AdminCreateUser, SignUp}

  For each new user this Lambda:
    1. Derives the canonical subdomain from email local-part (lowercase, [a-z0-9-], 3-30).
    2. Writes `custom:subdomain` back to Cognito (so dashboard / DNS / IAM names all
       converge on the same value regardless of how the user was created — sh seed,
       dashboard /api/users POST, AWS Console, or SDK).
    3. Creates the Local Governance per-user role `cc-on-bedrock-local-user-{sub}`
       (covers the IAM propagation race for `cc` login).
    4. Creates the EC2 mode per-user role + instance profile
       `cc-on-bedrock-task-{subdomain}` (covers the IAM propagation race for first
       EC2 instance start — see ec2-clients.ts:ensureUserInstanceProfile).

Also supports direct invoke for backfill / manual repair:
   {"action":"ensure","sub":"...","username":"...","department":"...","project":"..."}
"""
import json
import os
import re
import boto3

from role_factory import ensure_role

USER_POOL_ID = os.environ.get("USER_POOL_ID", "")
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
PERMISSION_BOUNDARY_NAME = os.environ.get("PERMISSION_BOUNDARY_NAME", "cc-on-bedrock-task-boundary")

cognito = boto3.client("cognito-idp")
iam = boto3.client("iam")

print("user-role-provisioner cold start")

EC2_ROLE_PREFIX = "cc-on-bedrock-task-"


def derive_subdomain(email_or_username: str) -> str:
    """Email local-part -> canonical subdomain.

    Rules (matches validation.ts regex /^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 3-30 chars):
      - take local-part before '@'
      - lowercase
      - non-[a-z0-9] -> '-'
      - collapse repeating dashes, strip leading/trailing dashes
      - pad with '0' if shorter than 3 chars, truncate to 30
    """
    local = (email_or_username or "").split("@")[0].lower()
    cleaned = re.sub(r"[^a-z0-9-]", "-", local)
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    if len(cleaned) < 3:
        cleaned = (cleaned + "000")[:3]
    return cleaned[:30]


def _admin_get_user_by_sub(sub: str) -> dict:
    resp = cognito.list_users(UserPoolId=USER_POOL_ID, Filter=f'sub = "{sub}"', Limit=1)
    users = resp.get("Users") or []
    if not users:
        return {}
    username = users[0]["Username"]
    full = cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=username)
    attrs = {a["Name"]: a["Value"] for a in full.get("UserAttributes", [])}
    return {
        "username_internal": username,
        "sub": sub,
        "email": attrs.get("email") or username,
        "department": attrs.get("custom:department") or "default",
        "project": attrs.get("custom:project") or "default",
        "existing_subdomain": attrs.get("custom:subdomain") or "",
        "existing_dept_manager_sub": attrs.get("custom:dept_manager_sub") or "",
    }


def _find_dept_manager_sub(department: str) -> str | None:
    """Find sub of the dept-manager group member whose custom:department == department.

    list-users-in-group is paginated; we walk pages but stop on first match.
    Returns None if no manager exists yet (chicken-and-egg case before the
    manager is assigned to the group)."""
    paginator = cognito.get_paginator("list_users_in_group")
    for page in paginator.paginate(UserPoolId=USER_POOL_ID, GroupName="dept-manager"):
        for u in page.get("Users", []):
            attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
            if attrs.get("custom:department") == department:
                return attrs.get("sub")
    return None


def _list_dept_members(department: str) -> list:
    """Every user (any group) whose custom:department == department. Used to
    refresh `dept_manager_sub` on all members when the manager changes.

    Cognito list-users Filter does NOT support custom attributes (raises
    InvalidParameterException), so we scan all users and filter client-side."""
    paginator = cognito.get_paginator("list_users")
    out = []
    for page in paginator.paginate(UserPoolId=USER_POOL_ID, Limit=60):
        for u in page.get("Users", []):
            attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
            if attrs.get("custom:department") == department:
                out.append(u)
    return out


def _extract_sub_from_event(detail: dict) -> str | None:
    add = detail.get("additionalEventData") or {}
    sub = add.get("sub")
    if sub:
        return sub
    resp = detail.get("responseElements") or {}
    return resp.get("userSub")


def _write_subdomain(internal_username: str, subdomain: str) -> None:
    cognito.admin_update_user_attributes(
        UserPoolId=USER_POOL_ID,
        Username=internal_username,
        UserAttributes=[{"Name": "custom:subdomain", "Value": subdomain}],
    )


def _write_dept_manager_sub(internal_username: str, manager_sub: str) -> None:
    cognito.admin_update_user_attributes(
        UserPoolId=USER_POOL_ID,
        Username=internal_username,
        UserAttributes=[{"Name": "custom:dept_manager_sub", "Value": manager_sub}],
    )


def _ec2_task_trust_policy() -> dict:
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "ec2.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    }


def _ec2_task_inline_policy() -> dict:
    """Mirrors the policy attached by ec2-clients.ts:ensureUserInstanceProfile's
    DevenvAccess inline policy. Pre-creating it here removes the IAM-propagation
    race on first EC2 instance start; ec2-clients.ts hits the exists-branch."""
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "BedrockClaude",
                "Effect": "Allow",
                "Action": [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                    "bedrock:Converse",
                    "bedrock:ConverseStream",
                ],
                "Resource": [
                    "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
                    f"arn:aws:bedrock:*:{ACCOUNT_ID}:inference-profile/*anthropic.claude-*",
                ],
            },
            {
                "Sid": "SSMSessionManager",
                "Effect": "Allow",
                "Action": [
                    "ssmmessages:CreateControlChannel",
                    "ssmmessages:CreateDataChannel",
                    "ssmmessages:OpenControlChannel",
                    "ssmmessages:OpenDataChannel",
                    "ssm:UpdateInstanceInformation",
                ],
                "Resource": "*",
            },
            {
                "Sid": "CloudWatch",
                "Effect": "Allow",
                "Action": [
                    "cloudwatch:PutMetricData",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "logs:CreateLogGroup",
                ],
                "Resource": "*",
            },
        ],
    }


def _ensure_ec2_task_role(subdomain: str, email: str, department: str) -> dict:
    """Create or refresh the EC2 mode per-user IAM role + instance profile.
    Mirrors ec2-clients.ts:ensureUserInstanceProfile but runs ahead of first start."""
    role_name = f"{EC2_ROLE_PREFIX}{subdomain}"
    tags = [
        {"Key": "cc-on-bedrock", "Value": "user-instance-role"},
        {"Key": "username", "Value": email},
        {"Key": "department", "Value": department or "default"},
        {"Key": "project", "Value": "cc-on-bedrock"},
        {"Key": "subdomain", "Value": subdomain},
        {"Key": "cost-center", "Value": department or "default"},
    ]
    created = False
    try:
        iam.get_role(RoleName=role_name)
        iam.tag_role(RoleName=role_name, Tags=tags)
    except iam.exceptions.NoSuchEntityException:
        iam.create_role(
            RoleName=role_name,
            AssumeRolePolicyDocument=json.dumps(_ec2_task_trust_policy()),
            PermissionsBoundary=f"arn:aws:iam::{ACCOUNT_ID}:policy/{PERMISSION_BOUNDARY_NAME}",
            Description=f"Per-user EC2 DevEnv Role for {subdomain}",
            Tags=tags,
        )
        created = True

    iam.put_role_policy(
        RoleName=role_name,
        PolicyName="DevenvAccess",
        PolicyDocument=json.dumps(_ec2_task_inline_policy()),
    )

    profile_name = role_name
    try:
        prof = iam.get_instance_profile(InstanceProfileName=profile_name)
        attached_roles = prof.get("InstanceProfile", {}).get("Roles") or []
        if not any(r.get("RoleName") == role_name for r in attached_roles):
            # Profile exists but the role is not attached (e.g. a previous run
            # crashed between CreateInstanceProfile and AddRoleToInstanceProfile).
            iam.add_role_to_instance_profile(InstanceProfileName=profile_name, RoleName=role_name)
    except iam.exceptions.NoSuchEntityException:
        iam.create_instance_profile(InstanceProfileName=profile_name)
        iam.add_role_to_instance_profile(InstanceProfileName=profile_name, RoleName=role_name)

    return {
        "roleArn": f"arn:aws:iam::{ACCOUNT_ID}:role/{role_name}",
        "instanceProfile": profile_name,
        "created": created,
    }


def _provision_user(info: dict) -> dict:
    """Run the full provisioning pipeline for one user record from AdminGetUser."""
    sub = info["sub"]
    email = info["email"]
    department = info["department"]
    project = info["project"]
    internal_username = info["username_internal"]

    subdomain = derive_subdomain(email)
    sub_changed = info.get("existing_subdomain") != subdomain
    if sub_changed:
        _write_subdomain(internal_username, subdomain)

    # Look up the department manager and pin it on the new user. If the manager
    # hasn't been added to the dept-manager group yet (chicken-and-egg on the
    # very first user per dept), this stays empty — the AdminAddUserToGroup
    # event handler below backfills it once the manager joins the group.
    manager_sub = _find_dept_manager_sub(department) or ""
    manager_changed = info.get("existing_dept_manager_sub") != manager_sub
    if manager_changed and manager_sub:
        _write_dept_manager_sub(internal_username, manager_sub)

    local_result = ensure_role(
        sub=sub, username=email, department=department, project=project,
    )
    ec2_result = _ensure_ec2_task_role(subdomain, email, department)

    return {
        "sub": sub,
        "email": email,
        "department": department,
        "subdomain": subdomain,
        "subdomainUpdated": sub_changed,
        "deptManagerSub": manager_sub,
        "deptManagerUpdated": manager_changed and bool(manager_sub),
        "localGovRole": local_result,
        "ec2Role": ec2_result,
    }


def _refresh_dept_manager_for_dept(department: str, manager_sub: str) -> dict:
    """Triggered when a user joins dept-manager group. Set custom:dept_manager_sub
    on every member of the department (including the manager themselves) to the
    new manager's sub. Idempotent — skip rows whose value is already correct."""
    members = _list_dept_members(department)
    updated = 0
    skipped = 0
    for u in members:
        attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
        if attrs.get("custom:dept_manager_sub") == manager_sub:
            skipped += 1
            continue
        _write_dept_manager_sub(u["Username"], manager_sub)
        updated += 1
    return {"department": department, "managerSub": manager_sub, "updated": updated, "unchanged": skipped}


def handler(event, context):
    # Direct invoke (backfill / manual repair). Accepts either {action:ensure, sub:...}
    # or {action:ensure-full, sub:...} — both run the full pipeline.
    if isinstance(event, dict) and event.get("action") in ("ensure", "ensure-full"):
        sub = event.get("sub")
        if not sub:
            raise ValueError("action=ensure requires sub")
        info = _admin_get_user_by_sub(sub)
        if not info:
            raise ValueError(f"sub {sub} not found in Cognito")
        if event.get("department"):
            info["department"] = event["department"]
        if event.get("project"):
            info["project"] = event["project"]
        result = _provision_user(info)
        print(
            f"ensure sub={sub} email={info['email']} subdomain={result['subdomain']} "
            f"local.created={result['localGovRole']['created']} "
            f"ec2.created={result['ec2Role']['created']}"
        )
        return result

    # EventBridge CloudTrail event path.
    detail = (event or {}).get("detail") or {}
    event_name = detail.get("eventName", "")
    if detail.get("errorCode"):
        print(f"upstream {event_name} failed: {detail.get('errorCode')} — skipping")
        return {"skipped": True, "upstreamError": detail.get("errorCode")}

    # AdminAddUserToGroup: if the target group is `dept-manager`, refresh all
    # dept members so their custom:dept_manager_sub points to the new manager.
    if event_name == "AdminAddUserToGroup":
        req = detail.get("requestParameters") or {}
        group_name = req.get("groupName")
        if group_name != "dept-manager":
            return {"skipped": True, "reason": "group_not_dept_manager", "group": group_name}
        # CloudTrail redacts username; pull from responseElements or requestParameters.
        username_internal = req.get("username")
        if not username_internal or username_internal == "HIDDEN_DUE_TO_SECURITY_REASONS":
            print(f"AdminAddUserToGroup: username redacted — cannot resolve manager sub")
            return {"skipped": True, "reason": "username_redacted"}
        try:
            full = cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=username_internal)
        except cognito.exceptions.UserNotFoundException:
            return {"skipped": True, "reason": "user_not_found", "username": username_internal}
        attrs = {a["Name"]: a["Value"] for a in full.get("UserAttributes", [])}
        manager_sub = attrs.get("sub")
        department = attrs.get("custom:department") or "default"
        if not manager_sub:
            return {"skipped": True, "reason": "no_sub_on_manager"}
        result = _refresh_dept_manager_for_dept(department, manager_sub)
        print(f"dept-manager promoted: dept={department} managerSub={manager_sub} updated={result['updated']} unchanged={result['unchanged']}")
        return result

    # AdminCreateUser / SignUp path.
    sub = _extract_sub_from_event(detail)
    if not sub:
        print(f"no sub in event detail (eventName={event_name}) — skipping")
        return {"skipped": True, "reason": "no_sub"}

    info = _admin_get_user_by_sub(sub)
    if not info:
        print(f"AdminGetUser empty for sub={sub} (possibly deleted) — skipping")
        return {"skipped": True, "reason": "user_not_found", "sub": sub}

    result = _provision_user(info)
    print(
        f"provisioned eventName={event_name} sub={sub} email={info['email']} "
        f"subdomain={result['subdomain']} subdomainUpdated={result['subdomainUpdated']} "
        f"deptManagerSub={result['deptManagerSub']} "
        f"local.created={result['localGovRole']['created']} "
        f"ec2.created={result['ec2Role']['created']}"
    )
    return result
