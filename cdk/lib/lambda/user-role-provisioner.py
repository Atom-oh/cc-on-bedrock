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
from botocore.exceptions import ClientError

from role_factory import ensure_role

# Fail fast at cold-start if USER_POOL_ID is missing — every code path needs it,
# and an empty string would let calls into cognito.list_users(UserPoolId="")
# surface as runtime InvalidParameterException instead of a configuration error.
USER_POOL_ID = os.environ["USER_POOL_ID"]
ACCOUNT_ID = os.environ["ACCOUNT_ID"]

# Cognito sub is a UUID v4 (8-4-4-4-12 hex); we validate inputs on the
# direct-invoke path before interpolating into the Cognito ListUsers Filter
# expression, since that path takes caller-controlled values (backfill script,
# manual repair tools). EventBridge events deliver AWS-issued subs so this is
# defense in depth.
_SUB_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
# Same shape that validation.ts enforces on subdomain input: 3-30 chars,
# lowercase alphanumeric or hyphen, must start AND end alphanumeric.
# Used to validate the operator-supplied `subdomain` field on the
# `action=deprovision` direct-invoke path before it reaches IAM/EC2/DDB calls
# whose resource names are constructed from it.
_SUBDOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")
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
      - truncate to 30

    Raises ValueError if the resulting subdomain would be shorter than 3 chars.
    Previously we padded with '000' which made every empty-local-part user collide
    onto a shared `cc-on-bedrock-task-000` role — an obvious privilege-bridging
    hole. Fail loudly so the caller surfaces a real error to the admin instead.
    """
    local = (email_or_username or "").split("@")[0].lower()
    cleaned = re.sub(r"[^a-z0-9-]", "-", local)
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    # Truncate first, THEN re-strip — `cleaned[:30]` could land on a `-` and
    # violate validation.ts regex /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ if the 30th
    # char is a sanitization-inserted dash.
    truncated = cleaned[:30].rstrip("-")
    if len(truncated) < 3:
        raise ValueError(
            f"cannot derive subdomain from email/username {email_or_username!r}: "
            f"sanitized result {truncated!r} (must be >= 3 chars and end alphanumeric)"
        )
    return truncated


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
    """Returns a sub only if it matches the Cognito UUID format. EventBridge
    delivers AWS-issued subs which are well-formed, but we validate before
    interpolating into the Cognito ListUsers Filter — defense in depth, same
    pattern the direct-invoke and AdminDeleteUser paths use."""
    add = detail.get("additionalEventData") or {}
    sub = add.get("sub")
    if not sub:
        resp = detail.get("responseElements") or {}
        sub = resp.get("userSub")
    if sub and _SUB_RE.match(sub):
        return sub
    return None


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


def _ensure_ec2_task_role(subdomain: str, email: str, department: str, sub: str) -> dict:
    """Create or refresh the EC2 mode per-user IAM role + instance profile.
    Mirrors ec2-clients.ts:ensureUserInstanceProfile but runs ahead of first start.

    Subdomain collision guard: if a role with the same name already exists tagged
    to a different Cognito sub, raise instead of silently re-tagging. Subdomains
    derive from email local-part, so `user01@a.com` and `user01@b.com` would
    naturally collide; rather than silently hand the second user the first
    user's EC2 permissions, we fail and require the admin to disambiguate.
    """
    role_name = f"{EC2_ROLE_PREFIX}{subdomain}"
    tags = [
        {"Key": "cc-on-bedrock", "Value": "user-instance-role"},
        {"Key": "username", "Value": email},
        {"Key": "department", "Value": department or "default"},
        {"Key": "project", "Value": "cc-on-bedrock"},
        {"Key": "subdomain", "Value": subdomain},
        {"Key": "cost-center", "Value": department or "default"},
        {"Key": "cognito_sub", "Value": sub},
    ]
    created = False
    try:
        iam.get_role(RoleName=role_name)
        existing = iam.list_role_tags(RoleName=role_name).get("Tags", [])
        existing_sub = next((t["Value"] for t in existing if t["Key"] == "cognito_sub"), "")
        if existing_sub and existing_sub != sub:
            raise RuntimeError(
                f"subdomain collision on {role_name}: existing role owned by "
                f"cognito_sub={existing_sub!r} but provisioner invoked for sub={sub!r}. "
                f"Two users derived the same subdomain — likely same email local-part "
                f"across different domains. Resolve by changing one email or extending "
                f"derive_subdomain() to disambiguate."
            )
        if not existing_sub:
            # Pre-ADR-022 role created by ec2-clients.ts:ensureUserInstanceProfile
            # (it tagged username + subdomain but not cognito_sub). Use the legacy
            # `username` tag to decide whether this is the same user being
            # backfilled (safe to take over) or a different user colliding on
            # the subdomain (must reject; otherwise two Cognito users share one
            # IAM identity — cross-tenant privilege leak).
            existing_username = next(
                (t["Value"] for t in existing if t["Key"] == "username"), ""
            )
            if not existing_username or existing_username != email:
                raise RuntimeError(
                    f"legacy role {role_name} has no cognito_sub tag and its "
                    f"username tag ({existing_username!r}) does not match the "
                    f"current user email ({email!r}). Refusing takeover for "
                    f"sub={sub!r} — delete the legacy role manually after "
                    f"confirming ownership, or invoke the deprovisioner."
                )
            # Same-user backfill: fall through and tag_role adds cognito_sub.
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
    # An empty manager_sub is still written (clearing a stale pointer) so that
    # demoting the previous manager doesn't leave dept members pointing at a
    # user who is no longer in the dept-manager group.
    manager_sub = _find_dept_manager_sub(department) or ""
    manager_changed = info.get("existing_dept_manager_sub") != manager_sub
    if manager_changed:
        _write_dept_manager_sub(internal_username, manager_sub)

    local_result = ensure_role(
        sub=sub, username=email, department=department, project=project,
    )
    ec2_result = _ensure_ec2_task_role(subdomain, email, department, sub)

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


def _ensure_default_group(username_internal: str) -> str | None:
    """If a freshly-created user has no group membership, add them to `user`.

    Cognito users created via AWS Console / SDK / IdP federation often arrive
    with no group set, which makes the dashboard's auth middleware reject them
    (it expects `admin` / `dept-manager` / `user`). The seed script sets group
    explicitly so this is a no-op for those. Returns the group it assigned, or
    None if the user already had at least one group.
    """
    try:
        resp = cognito.admin_list_groups_for_user(UserPoolId=USER_POOL_ID, Username=username_internal)
        if resp.get("Groups"):
            return None
        cognito.admin_add_user_to_group(
            UserPoolId=USER_POOL_ID, Username=username_internal, GroupName="user",
        )
        return "user"
    except ClientError as e:
        # Cognito-side failure (throttling, AccessDeniedException, user not
        # found, etc.). Log ERROR so CloudWatch metric filters or alarms can
        # surface a sustained problem — sustained misses leave users with no
        # group and the dashboard auth middleware rejects them, so silent
        # swallow used to mean "users complain they can't log in" without an
        # operator signal. Returning None keeps the caller flow intact; the
        # ERROR log line is the actionable bit.
        code = e.response.get("Error", {}).get("Code", "Unknown")
        print(f"ERROR default-group assign failed for {username_internal}: {code}: {e}")
        return None
    # Note: unknown exceptions intentionally propagate — they indicate a code
    # bug or a runtime IAM-perms regression and should fail the invocation so
    # EventBridge retries (and DLQs after exhaustion) rather than masking.


# ────────────────────────────────────────────────────────────────────────
# Deletion path (ADR-024)
# ────────────────────────────────────────────────────────────────────────

LIMITS_TABLE = os.environ.get("LIMITS_TABLE", "cc-on-bedrock-limits")
USER_INSTANCES_TABLE = os.environ.get("USER_INSTANCES_TABLE", "cc-user-instances")
USER_VOLUMES_TABLE = os.environ.get("USER_VOLUMES_TABLE", "cc-user-volumes")
ROUTING_TABLE = os.environ.get("ROUTING_TABLE", "cc-routing-table")
CODESERVER_SECRET_PREFIX = "cc-on-bedrock/codeserver/"

ddb = boto3.client("dynamodb")
secrets = boto3.client("secretsmanager")
ec2 = boto3.client("ec2")


def _safe_delete_role(role_name: str) -> str:
    """Delete an IAM role and its inline policies. Returns 'deleted' / 'absent' / 'error: ...'."""
    try:
        for p in iam.list_role_policies(RoleName=role_name).get("PolicyNames", []):
            iam.delete_role_policy(RoleName=role_name, PolicyName=p)
        iam.delete_role(RoleName=role_name)
        return "deleted"
    except iam.exceptions.NoSuchEntityException:
        return "absent"
    except Exception as e:
        print(f"delete_role {role_name} failed: {e}")
        return f"error: {e.__class__.__name__}"


def _safe_delete_instance_profile(profile_name: str) -> str:
    try:
        prof = iam.get_instance_profile(InstanceProfileName=profile_name)
        for r in prof.get("InstanceProfile", {}).get("Roles", []):
            iam.remove_role_from_instance_profile(
                InstanceProfileName=profile_name, RoleName=r["RoleName"],
            )
        iam.delete_instance_profile(InstanceProfileName=profile_name)
        return "deleted"
    except iam.exceptions.NoSuchEntityException:
        return "absent"
    except Exception as e:
        print(f"delete_instance_profile {profile_name} failed: {e}")
        return f"error: {e.__class__.__name__}"


def _safe_delete_ddb_item(table: str, key: dict) -> str:
    try:
        ddb.delete_item(TableName=table, Key=key)
        return "deleted"
    except ClientError as e:
        # `governanceOnly=true` mode skips Stack 04/07 → cc-user-instances,
        # cc-user-volumes, cc-routing-table don't exist. DeleteItem on missing
        # table returns ResourceNotFoundException — that's "nothing to clean up
        # here", not an error worth retrying / DLQ'ing.
        code = e.response.get("Error", {}).get("Code", "")
        if code == "ResourceNotFoundException":
            return "absent"
        print(f"delete_item {table} {key} failed: {e}")
        return f"error: {code or e.__class__.__name__}"


def _safe_delete_secret(name: str) -> str:
    try:
        secrets.delete_secret(SecretId=name, ForceDeleteWithoutRecovery=True)
        return "deleted"
    except secrets.exceptions.ResourceNotFoundException:
        return "absent"
    except Exception as e:
        print(f"delete_secret {name} failed: {e}")
        return f"error: {e.__class__.__name__}"


def _terminate_user_instances(subdomain: str) -> dict:
    """Find EC2 instances tagged subdomain=<subdomain> AND managed_by=cc-on-bedrock
    and terminate them.

    The managed_by filter is required at the describe layer so a stray instance
    with a matching subdomain tag (e.g. created outside this project) is never
    even considered — otherwise the subsequent terminate_instances call would
    fail with UnauthorizedOperation (the IAM policy requires the managed_by tag)
    and silently roll back the entire terminate batch.

    Returns {"instanceIds": [...], "error": str|None}. An empty instanceIds with
    error=None means there were no matching instances; error set means the call
    itself failed and the caller should not assume cleanup completed.
    """
    try:
        resp = ec2.describe_instances(
            Filters=[
                {"Name": "tag:subdomain", "Values": [subdomain]},
                {"Name": "tag:managed_by", "Values": ["cc-on-bedrock"]},
                {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
            ],
        )
        ids = [
            i["InstanceId"]
            for r in resp.get("Reservations", [])
            for i in r.get("Instances", [])
        ]
        if not ids:
            return {"instanceIds": [], "error": None}
        ec2.terminate_instances(InstanceIds=ids)
        return {"instanceIds": ids, "error": None}
    except Exception as e:
        msg = f"{e.__class__.__name__}: {e}"
        print(f"ERROR terminate_user_instances {subdomain} failed: {msg}")
        return {"instanceIds": [], "error": msg}


def _deprovision_user(sub: str, override_subdomain: str | None = None) -> dict:
    """ADR-024: clean every per-user resource created by the provisioner pipeline.

    Order matters: terminate EC2 instances first (they reference the instance
    profile), then remove the instance profile, then roles, then DDB state and
    secrets. We tolerate NoSuchEntity at every step so a partial-create that
    crashed mid-pipeline can still be fully reaped.

    The Cognito user is already gone by the time we receive AdminDeleteUser.
    We use the local-user role's tags to recover the email → subdomain mapping
    needed for the EC2-side resources (whose names are subdomain-based).

    `override_subdomain` is the operator escape hatch for cases where the
    local-user role is missing or its email tag can't be sanitized — pass it
    explicitly via direct-invoke."""
    local_role = f"cc-on-bedrock-local-user-{sub}"
    result: dict = {"sub": sub, "subdomain": override_subdomain}

    # Recover subdomain via the local-user role's `username` tag (= email).
    # If the caller already passed an explicit subdomain (direct-invoke path
    # for users created before ADR-022, or where the local-role is missing),
    # honor that and skip the tag lookup.
    if result.get("subdomain"):
        pass  # caller-provided
    else:
        try:
            tag_resp = iam.list_role_tags(RoleName=local_role)
            tag_map = {t["Key"]: t["Value"] for t in tag_resp.get("Tags", [])}
            email = tag_map.get("username") or ""
            if email:
                try:
                    result["subdomain"] = derive_subdomain(email)
                except ValueError as e:
                    # Surface the error so the operator can re-invoke with an
                    # explicit subdomain. Without this, EC2/DDB/Secret cleanup
                    # silently no-ops and orphan resources accumulate.
                    print(f"ERROR deprovision sub={sub} email={email}: subdomain derivation failed ({e}); "
                          f"re-invoke with {{\"action\":\"deprovision\",\"sub\":\"{sub}\",\"subdomain\":\"<value>\"}}")
                    result["subdomainError"] = str(e)
        except iam.exceptions.NoSuchEntityException:
            print(f"WARN deprovision sub={sub}: local-user role absent; cannot recover subdomain. "
                  f"Re-invoke with explicit subdomain if EC2-side cleanup is needed.")
            result["subdomainError"] = "local_role_missing"

    subdomain = result["subdomain"]

    # EC2 instances tagged with the subdomain (if known)
    if subdomain:
        terminated = _terminate_user_instances(subdomain)
        result["terminatedInstances"] = terminated

        # Instance profile + EC2 task role
        result["ec2InstanceProfile"] = _safe_delete_instance_profile(f"cc-on-bedrock-task-{subdomain}")
        result["ec2TaskRole"] = _safe_delete_role(f"cc-on-bedrock-task-{subdomain}")

        # DDB state keyed on subdomain (or user_id == subdomain in cc-user-instances)
        result["userInstancesRow"] = _safe_delete_ddb_item(
            USER_INSTANCES_TABLE, {"user_id": {"S": subdomain}}
        )
        result["userVolumesRow"] = _safe_delete_ddb_item(
            USER_VOLUMES_TABLE, {"user_id": {"S": subdomain}}
        )
        result["routingRow"] = _safe_delete_ddb_item(
            ROUTING_TABLE, {"subdomain": {"S": subdomain}}
        )

        # Codeserver password secret
        result["codeserverSecret"] = _safe_delete_secret(f"{CODESERVER_SECRET_PREFIX}{subdomain}")

    # NOTE: local Governance role deletion is deferred to AFTER the error
    # aggregator below. The local-user role tags carry the username (email)
    # that we use to recover `subdomain` on retry. If we delete it here and
    # any EC2-side cleanup fails (e.g. DeleteConflict while EC2 still
    # shutting-down), the aggregator raises → EventBridge retries → but the
    # retry can't find the local role anymore → can't derive subdomain →
    # EC2 cleanup loop is silently skipped on every subsequent attempt.
    # Keep the local role until we know the rest succeeded.

    # Limits-table rows (Local Governance) — per-user counter / deny / warn
    # share PK=USER#{sub}; sweep all SKs. Paginated because daily counters can
    # accumulate past the 1MB / 100-item single-page response window.
    try:
        deleted_limits = 0
        paginator = ddb.get_paginator("query")
        for page in paginator.paginate(
            TableName=LIMITS_TABLE,
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues={":pk": {"S": f"USER#{sub}"}},
        ):
            for item in page.get("Items", []):
                ddb.delete_item(
                    TableName=LIMITS_TABLE,
                    Key={"PK": item["PK"], "SK": item["SK"]},
                )
                deleted_limits += 1
        result["limitsRowsDeleted"] = deleted_limits
    except Exception as e:
        print(f"limits sweep for sub={sub} failed: {e}")
        result["limitsRowsDeleted"] = f"error: {e.__class__.__name__}"

    # Aggregate any partial-failure markers. Three shapes carry an error:
    #   - string starting with "error:"   — _safe_delete_* and the limits sweep
    #   - dict with non-None "error"       — _terminate_user_instances
    #   - top-level `subdomainError` key   — derive_subdomain failure or
    #     local-role-absent (set in the subdomain-recovery block above).
    #     Without this branch, an unsanitizable email or missing local role
    #     would skip EC2/DDB/Secret cleanup AND then silently delete the
    #     local-user role, losing the `username` tag needed to ever recover.
    # Raising lets EventBridge retry (default 2 attempts, then DLQ) instead of
    # silently returning 200 to a half-completed cleanup. DeleteConflict
    # (running EC2 still holding the instance profile) is explicitly retryable —
    # the instance moves to `terminated` within minutes and the retry completes.
    errors: list[str] = []
    for k, v in result.items():
        if isinstance(v, str) and v.startswith("error:"):
            errors.append(f"{k}={v}")
        elif isinstance(v, dict) and v.get("error"):
            errors.append(f"{k}={v['error']}")
    if result.get("subdomainError"):
        errors.append(f"subdomainError={result['subdomainError']}")
    if errors:
        result["errors"] = errors
        # NOTE: do NOT delete local_role here — its tags are needed to recover
        # `subdomain` on EventBridge retry. The retry's _deprovision_user call
        # will read the tags, drive cleanup, and (if successful this time)
        # fall through to the local role deletion below.
        raise RuntimeError(
            f"deprovision sub={sub} partial-completion: {len(errors)} step(s) failed: "
            f"{'; '.join(errors)}. EventBridge will retry; if DeleteConflict, "
            f"the running EC2 instance must terminate first."
        )

    # All other cleanup succeeded — safe to drop the local-user role last.
    # (Done after the aggregator so the role's `username` tag remains
    # available to recover subdomain on retry if any earlier step failed.)
    result["localGovRole"] = _safe_delete_role(local_role)

    return result


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
    # Direct invoke — deletion (ADR-024). {"action":"deprovision","sub":"...","subdomain":"..."}.
    # The Cognito user is presumed already deleted; we just reap the per-user
    # downstream resources. Idempotent: rerunning on a fully-clean sub is a no-op.
    # `subdomain` is optional — supplied when the local-user role is missing or
    # derive_subdomain can't recover the value (operator escape hatch).
    if isinstance(event, dict) and event.get("action") == "deprovision":
        sub = event.get("sub")
        if not sub or not _SUB_RE.match(sub):
            raise ValueError(f"action=deprovision requires a valid sub UUID, got {sub!r}")
        explicit_subdomain = event.get("subdomain")
        if explicit_subdomain is not None:
            # The operator-supplied subdomain is interpolated into IAM role names,
            # instance profile names, DDB keys, secret names, and EC2 tag filters.
            # Validate against the same shape `validation.ts` enforces on inbound
            # form data so a malformed value can't construct unintended ARNs /
            # match unrelated tags.
            if not isinstance(explicit_subdomain, str) or not _SUBDOMAIN_RE.match(explicit_subdomain):
                raise ValueError(
                    f"action=deprovision subdomain must match {_SUBDOMAIN_RE.pattern}, "
                    f"got {explicit_subdomain!r}"
                )
        result = _deprovision_user(sub, override_subdomain=explicit_subdomain)
        print(f"deprovisioned sub={sub} subdomain={result.get('subdomain') or '(unknown)'}: {result}")
        return result

    # Direct invoke (backfill / manual repair). Accepts either {action:ensure, sub:...}
    # or {action:ensure-full, sub:...} — both run the full pipeline.
    if isinstance(event, dict) and event.get("action") in ("ensure", "ensure-full"):
        sub = event.get("sub")
        if not sub:
            raise ValueError("action=ensure requires sub")
        if not _SUB_RE.match(sub):
            # Reject anything that isn't a Cognito UUID before it reaches
            # cognito.list_users(Filter=...) — narrow injection-surface.
            raise ValueError(f"sub {sub!r} is not a valid Cognito sub UUID")
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

    # AdminDeleteUser (ADR-024): fan-out cleanup of per-user resources.
    # Sub extraction order:
    #   1. additionalEventData.sub  — the documented CloudTrail field
    #   2. requestParameters.username — Cognito's internal username IS the
    #      sub for federated/SDK-created users; fall back when (1) is missing.
    # ERROR log on miss so a CloudWatch metric filter / alarm catches
    # accumulating skip events (the silent-skip path used to bury orphan
    # resources because no operator signal fired).
    if event_name == "AdminDeleteUser":
        add = detail.get("additionalEventData") or {}
        sub = add.get("sub")
        if not (sub and _SUB_RE.match(sub)):
            req = detail.get("requestParameters") or {}
            candidate = req.get("username")
            if candidate and candidate != "HIDDEN_DUE_TO_SECURITY_REASONS" and _SUB_RE.match(candidate):
                sub = candidate
                print(f"AdminDeleteUser: additionalEventData.sub missing, fell back to requestParameters.username={sub}")
        if not (sub and _SUB_RE.match(sub)):
            print(f"ERROR AdminDeleteUser: no usable sub in event payload (additionalEventData={add}, requestParameters={detail.get('requestParameters')}) — cleanup will NOT run; orphan resources possible")
            return {"skipped": True, "reason": "no_sub"}
        result = _deprovision_user(sub)
        print(f"deprovisioned eventName=AdminDeleteUser sub={sub} subdomain={result.get('subdomain') or '(unknown)'}")
        return result

    # AdminAddUserToGroup / AdminRemoveUserFromGroup on the dept-manager group:
    # refresh every member of the affected department so their custom:dept_manager_sub
    # points to the (new) manager, or to '' if the dept now has no manager.
    if event_name in ("AdminAddUserToGroup", "AdminRemoveUserFromGroup"):
        req = detail.get("requestParameters") or {}
        group_name = req.get("groupName")
        if group_name != "dept-manager":
            return {"skipped": True, "reason": "group_not_dept_manager", "group": group_name}

        # Resolve which user was promoted/demoted. CloudTrail redacts
        # requestParameters.username on some account configurations; fall back to
        # responseElements (occasionally populated) before giving up.
        username_internal = req.get("username")
        if not username_internal or username_internal == "HIDDEN_DUE_TO_SECURITY_REASONS":
            resp = detail.get("responseElements") or {}
            username_internal = (resp.get("user") or {}).get("username")
        if not username_internal or username_internal == "HIDDEN_DUE_TO_SECURITY_REASONS":
            print(f"{event_name}: username redacted in CloudTrail — cannot resolve dept")
            return {"skipped": True, "reason": "username_redacted"}

        try:
            full = cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=username_internal)
        except cognito.exceptions.UserNotFoundException:
            return {"skipped": True, "reason": "user_not_found", "username": username_internal}
        attrs = {a["Name"]: a["Value"] for a in full.get("UserAttributes", [])}
        department = attrs.get("custom:department") or "default"

        # Recompute the current manager for the dept after the membership change.
        # For Add: this is usually the user just added (if they were the only/first).
        # For Remove: this is whoever else is still in dept-manager + has this dept,
        # or empty if the dept now has no manager.
        new_manager_sub = _find_dept_manager_sub(department) or ""
        result = _refresh_dept_manager_for_dept(department, new_manager_sub)
        print(
            f"dept-manager {event_name}: dept={department} newManagerSub={new_manager_sub or '(none)'} "
            f"updated={result['updated']} unchanged={result['unchanged']}"
        )
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

    try:
        result = _provision_user(info)
    except ValueError as e:
        # derive_subdomain refuses unsanitizable email local-parts. Surfacing the
        # error to EventBridge would trigger retries and eventual DLQ loss; swallow
        # and log so an operator can act (the user record sits without subdomain
        # until manually fixed). RuntimeError (subdomain collision) DOES propagate
        # since that case demands admin attention.
        print(f"ERROR sub={sub} email={info.get('email')} unsanitizable — provisioning skipped: {e}")
        return {"skipped": True, "reason": "unsanitizable_email", "sub": sub, "email": info.get("email"), "error": str(e)}

    # Default group fallback (ADR-024): users created via AWS Console / SDK / SAML
    # often have no group attached, which makes dashboard auth middleware reject
    # the login. Drop them into the `user` group so they at least reach the user
    # portal. Seed-script-created users already have a group → no-op.
    assigned = _ensure_default_group(info["username_internal"])
    if assigned:
        print(f"default group assigned: sub={sub} email={info['email']} group={assigned}")

    print(
        f"provisioned eventName={event_name} sub={sub} email={info['email']} "
        f"subdomain={result['subdomain']} subdomainUpdated={result['subdomainUpdated']} "
        f"deptManagerSub={result['deptManagerSub']} "
        f"local.created={result['localGovRole']['created']} "
        f"ec2.created={result['ec2Role']['created']} "
        f"defaultGroup={assigned or '(already set)'}"
    )
    return result
