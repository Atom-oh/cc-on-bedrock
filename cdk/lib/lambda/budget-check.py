"""
Budget Check Lambda (runs every 5 minutes)
Checks DynamoDB for users exceeding daily budget AND department monthly budget.
Actions:
  Per-user daily budget:
    80%: SNS warning alert
    100%: Attach IAM Deny Policy to per-user Task Role + Cognito flag + SNS alert
    Next day: Remove Deny Policy automatically
  Department monthly budget:
    80%: SNS warning alert to dept managers
    100%: Block all department users via IAM Deny Policy
"""
import os
import json
import boto3
from datetime import datetime
from decimal import Decimal

TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
DEPT_BUDGETS_TABLE = os.environ.get("DEPT_BUDGETS_TABLE", "cc-department-budgets")
USER_BUDGETS_TABLE = os.environ.get("USER_BUDGETS_TABLE", "cc-user-budgets")
LIMITS_TABLE = os.environ.get("LIMITS_TABLE", "cc-on-bedrock-limits")  # ADR-014
ECS_CLUSTER = os.environ.get("ECS_CLUSTER_NAME", "cc-on-bedrock-devenv")
DAILY_BUDGET = float(os.environ.get("DAILY_BUDGET_USD", "50"))
USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "")
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
TASK_ROLE_PREFIX = "cc-on-bedrock-task"
LOCAL_ROLE_PREFIX = "cc-on-bedrock-local-user-"  # ADR-014 Local Governance Mode
MAX_SCAN_PAGES = 100
# Legacy policy names (kept for backward-compat cleanup)
DENY_POLICY_NAME = "BudgetExceededDeny"
DEPT_DENY_POLICY_NAME = "DeptBudgetExceededDeny"
# ADR-015 canonical policy names
LOCAL_TOKEN_DENY_POLICY_NAME = "cc-bedrock-local-token-deny"

dynamodb = boto3.resource("dynamodb")
dynamodb_client = boto3.client("dynamodb")
table = dynamodb.Table(TABLE_NAME)
dept_budgets_table = dynamodb.Table(DEPT_BUDGETS_TABLE)
user_budgets_table = dynamodb.Table(USER_BUDGETS_TABLE)
try:
    limits_table = dynamodb.Table(LIMITS_TABLE)
except Exception:
    limits_table = None
iam_client = boto3.client("iam")
cognito_client = boto3.client("cognito-idp")
sns_client = boto3.client("sns")


def get_today_usage():
    """Scan DynamoDB for all USER# entries today (with pagination)."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    user_spend = {}
    last_key = None
    pages = 0
    while True:
        params = {
            "FilterExpression": "begins_with(PK, :prefix) AND begins_with(SK, :today)",
            "ExpressionAttributeValues": {":prefix": "USER#", ":today": today},
        }
        if last_key:
            params["ExclusiveStartKey"] = last_key
        result = table.scan(**params)
        for item in result.get("Items", []):
            user = item["PK"].replace("USER#", "")
            cost = float(item.get("estimatedCost", 0))
            dept = item.get("department", "default")
            if user in user_spend:
                user_spend[user]["cost"] += cost
            else:
                user_spend[user] = {"cost": cost, "department": dept}
        last_key = result.get("LastEvaluatedKey")
        pages += 1
        if not last_key or pages >= MAX_SCAN_PAGES:
            break
    return user_spend


def get_monthly_usage_by_department():
    """Scan DynamoDB for all USER# entries this month, grouped by department (with pagination)."""
    now = datetime.utcnow()
    month_prefix = now.strftime("%Y-%m")
    dept_spend = {}  # {dept: {"cost": X, "users": set()}}
    last_key = None
    pages = 0
    while True:
        params = {
            "FilterExpression": "begins_with(PK, :prefix) AND begins_with(SK, :month)",
            "ExpressionAttributeValues": {":prefix": "USER#", ":month": month_prefix},
        }
        if last_key:
            params["ExclusiveStartKey"] = last_key
        result = table.scan(**params)
        for item in result.get("Items", []):
            user = item["PK"].replace("USER#", "")
            cost = float(item.get("estimatedCost", 0))
            dept = item.get("department", "default")
            if dept in dept_spend:
                dept_spend[dept]["cost"] += cost
                dept_spend[dept]["users"].add(user)
            else:
                dept_spend[dept] = {"cost": cost, "users": {user}}
        last_key = result.get("LastEvaluatedKey")
        pages += 1
        if not last_key or pages >= MAX_SCAN_PAGES:
            break
    return dept_spend


def get_department_budgets():
    """Fetch all department budgets from cc-department-budgets table (with pagination).

    ADR-023: returns per-dept dict with BOTH the total cap and the per-member default.
      monthlyBudget         — total dept cap (legacy field, drives dept-deny attach)
      perUserMonthlyBudget  — default per-member USD budget (used when user has no
                              explicit cc-user-budgets row, before global DAILY_BUDGET).
    """
    try:
        budgets: dict = {}
        last_key = None
        pages = 0
        while True:
            params = {}
            if last_key:
                params["ExclusiveStartKey"] = last_key
            result = dept_budgets_table.scan(**params)
            for item in result.get("Items", []):
                dept_id = item.get("dept_id", item.get("department", "default"))
                budgets[dept_id] = {
                    "monthlyBudget": float(item.get("monthlyBudget", item.get("monthly_limit", 0)) or 0),
                    "perUserMonthlyBudget": float(item.get("perUserMonthlyBudget", 0) or 0),
                }
            last_key = result.get("LastEvaluatedKey")
            pages += 1
            if not last_key or pages >= MAX_SCAN_PAGES:
                break
        return budgets
    except Exception as e:
        print(f"[DEPT] Failed to fetch department budgets: {e}")
        return {}


def _dept_total_budget(dept_budgets: dict, dept: str) -> float:
    """Backward-compat accessor: returns dept's `monthlyBudget` (total cap) as float."""
    entry = dept_budgets.get(dept)
    if not entry:
        return 0.0
    if isinstance(entry, dict):
        return float(entry.get("monthlyBudget", 0) or 0)
    return float(entry or 0)


def _dept_per_user_default(dept_budgets: dict, dept: str) -> float:
    """ADR-023 helper: returns dept's `perUserMonthlyBudget` default for new members."""
    entry = dept_budgets.get(dept)
    if not isinstance(entry, dict):
        return 0.0
    return float(entry.get("perUserMonthlyBudget", 0) or 0)


def _effective_user_budget(user_budgets: dict, dept_budgets: dict, user: str, dept: str) -> float:
    """ADR-023: resolve per-user effective USD budget for daily over-budget check.
    Priority: user explicit > dept perUserMonthlyBudget > global DAILY_BUDGET env."""
    user_explicit = float(user_budgets.get(user, {}).get("monthlyBudget", 0) or 0)
    if user_explicit > 0:
        return user_explicit
    dept_default = _dept_per_user_default(dept_budgets, dept)
    if dept_default > 0:
        return dept_default
    return float(DAILY_BUDGET)


def get_user_budgets():
    """Fetch per-user budget limits from cc-user-budgets table."""
    try:
        budgets = {}
        last_key = None
        pages = 0
        while True:
            params = {}
            if last_key:
                params["ExclusiveStartKey"] = last_key
            result = user_budgets_table.scan(**params)
            for item in result.get("Items", []):
                user_id = item.get("user_id", item.get("userId", ""))
                if user_id:
                    budgets[user_id] = {
                        "dailyTokenLimit": float(item.get("dailyTokenLimit", 0)),
                        "monthlyBudget": float(item.get("monthlyBudget", 0)),
                    }
            last_key = result.get("LastEvaluatedKey")
            pages += 1
            if not last_key or pages >= MAX_SCAN_PAGES:
                break
        return budgets
    except Exception as e:
        print(f"[USER-BUDGETS] Failed to fetch user budgets: {e}")
        return {}


def write_current_spend(user_spend, dept_spend):
    """Write computed currentSpend back to budget tables for dashboard display."""
    now = datetime.utcnow().isoformat()

    # Write per-user spend to cc-user-budgets
    for user, data in user_spend.items():
        try:
            user_budgets_table.update_item(
                Key={"user_id": user},
                UpdateExpression="SET currentSpend = :spend, lastChecked = :ts, department = :dept",
                ExpressionAttributeValues={
                    ":spend": Decimal(str(round(data["cost"], 6))),
                    ":ts": now,
                    ":dept": data["department"],
                },
            )
        except Exception as e:
            print(f"[SPEND] Failed to write user spend for {user}: {e}")

    # Write per-department spend to cc-department-budgets
    for dept, data in dept_spend.items():
        try:
            dept_budgets_table.update_item(
                Key={"dept_id": dept},
                UpdateExpression="SET currentSpend = :spend, lastChecked = :ts, memberCount = :mc",
                ExpressionAttributeValues={
                    ":spend": Decimal(str(round(data["cost"], 6))),
                    ":ts": now,
                    ":mc": len(data["users"]),
                },
            )
        except Exception as e:
            print(f"[SPEND] Failed to write dept spend for {dept}: {e}")


def get_user_department(subdomain: str) -> str:
    """Get user's department from Cognito custom attribute or return default."""
    if not USER_POOL_ID:
        return "default"
    try:
        result = cognito_client.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'custom:subdomain = "{subdomain}"',
            Limit=1,
        )
        users = result.get("Users", [])
        if users:
            for attr in users[0].get("Attributes", []):
                if attr["Name"] == "custom:department":
                    return attr["Value"]
        return "default"
    except Exception as e:
        print(f"[DEPT] Failed to get department for {subdomain}: {e}")
        return "default"


# Per-handler-invocation cache of Local Governance roles indexed by `username` tag.
# Reset at handler entry. Built lazily on first dept-over-budget event in that invocation.
_local_role_index: dict = {}
_local_role_index_built = False


def _build_local_role_index():
    """Scan all cc-on-bedrock-local-user-* roles once and index by `username` tag.
    Idempotent within a single handler invocation. The `built` flag is set in `finally`
    so a partial index from a mid-scan exception still prevents redundant re-scans
    within the same invocation (best-effort attribution > re-scan on every dept-over-budget hit)."""
    global _local_role_index, _local_role_index_built
    if _local_role_index_built:
        return
    _local_role_index = {}
    try:
        paginator = iam_client.get_paginator("list_roles")
        for page in paginator.paginate(PathPrefix="/"):
            for role in page.get("Roles", []):
                rname = role.get("RoleName", "")
                if not rname.startswith(LOCAL_ROLE_PREFIX):
                    continue
                try:
                    tags_resp = iam_client.list_role_tags(RoleName=rname)
                    uname = next(
                        (t["Value"] for t in tags_resp.get("Tags", []) if t["Key"] == "username"),
                        None,
                    )
                except Exception:
                    uname = None
                if uname:
                    _local_role_index.setdefault(uname, []).append(rname)
    except Exception as e:
        print(f"[DEPT-DENY] local role index build failed: {e}")
    finally:
        _local_role_index_built = True


def attach_dept_deny_policy(subdomain: str):
    """Attach department budget exceeded IAM Deny Policy.
    ADR-015 §3: applies to BOTH the per-user EC2 Task Role and any Local Governance role
    whose `username` tag matches the subdomain.
    """
    deny_policy = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "DeptBudgetExceededDenyBedrock",
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
    _build_local_role_index()
    role_names = [f"{TASK_ROLE_PREFIX}-{subdomain}"] + _local_role_index.get(subdomain, [])
    any_attached = False
    for role_name in role_names:
        try:
            iam_client.put_role_policy(
                RoleName=role_name,
                PolicyName=DEPT_DENY_POLICY_NAME,
                PolicyDocument=deny_policy,
            )
            print(f"[DEPT-DENY] Attached to {role_name}")
            any_attached = True
        except iam_client.exceptions.NoSuchEntityException:
            # EC2 task role may not exist for a Local-only user — silently skip.
            continue
        except Exception as e:
            print(f"[DEPT-DENY] Failed for {role_name}: {e}")
    return any_attached


def remove_dept_deny_policy(subdomain: str):
    """Remove department budget IAM Deny Policy from both EC2 Task Role and matching Local roles."""
    _build_local_role_index()
    role_names = [f"{TASK_ROLE_PREFIX}-{subdomain}"] + _local_role_index.get(subdomain, [])
    any_removed = False
    for role_name in role_names:
        try:
            iam_client.delete_role_policy(
                RoleName=role_name,
                PolicyName=DEPT_DENY_POLICY_NAME,
            )
            print(f"[DEPT-ALLOW] Removed dept deny from {role_name}")
            any_removed = True
        except iam_client.exceptions.NoSuchEntityException:
            continue
        except Exception as e:
            print(f"[DEPT-ALLOW] Failed for {role_name}: {e}")
    return any_removed


def attach_deny_policy(subdomain: str):
    """Attach IAM Deny Policy to user's per-user Task Role."""
    role_name = f"{TASK_ROLE_PREFIX}-{subdomain}"
    deny_policy = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "BudgetExceededDenyBedrock",
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
    try:
        iam_client.put_role_policy(
            RoleName=role_name,
            PolicyName=DENY_POLICY_NAME,
            PolicyDocument=deny_policy,
        )
        print(f"[DENY] Attached to {role_name}")
        return True
    except Exception as e:
        print(f"[DENY] Failed for {role_name}: {e}")
        return False


def remove_deny_policy(subdomain: str):
    """Remove IAM Deny Policy from user's Task Role (next-day reset)."""
    role_name = f"{TASK_ROLE_PREFIX}-{subdomain}"
    try:
        iam_client.delete_role_policy(
            RoleName=role_name,
            PolicyName=DENY_POLICY_NAME,
        )
        print(f"[ALLOW] Removed deny from {role_name}")
        return True
    except iam_client.exceptions.NoSuchEntityException:
        return False  # No deny policy exists
    except Exception as e:
        print(f"[ALLOW] Failed for {role_name}: {e}")
        return False


def check_deny_exists(subdomain: str) -> bool:
    """Check if Deny Policy already exists on user's role."""
    role_name = f"{TASK_ROLE_PREFIX}-{subdomain}"
    try:
        iam_client.get_role_policy(
            RoleName=role_name,
            PolicyName=DENY_POLICY_NAME,
        )
        return True
    except Exception:
        return False


# ──────────────────────────────────────────────────────────
# ADR-014 / ADR-015 — Local Governance Mode helpers
# ──────────────────────────────────────────────────────────

def _resolve_role_candidates(user_key: str):
    """Return list of plausible role names for a user_key.
    EC2 mode uses subdomain → cc-on-bedrock-task-{subdomain};
    Local mode uses Cognito sub → cc-on-bedrock-local-user-{sub_short}.
    """
    import re as _re
    safe = _re.sub(r"[^A-Za-z0-9_-]", "-", user_key)[:40]
    return [
        f"{TASK_ROLE_PREFIX}-{user_key}",
        f"{LOCAL_ROLE_PREFIX}{safe}",
    ]


def _has_local_token_deny(role_name: str) -> bool:
    try:
        iam_client.get_role_policy(
            RoleName=role_name,
            PolicyName=LOCAL_TOKEN_DENY_POLICY_NAME,
        )
        return True
    except Exception:
        return False


def _attach_local_token_deny(role_name: str, reason: str) -> bool:
    doc = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "TokenLimitExceededDenyBackup",
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
    try:
        iam_client.put_role_policy(
            RoleName=role_name,
            PolicyName=LOCAL_TOKEN_DENY_POLICY_NAME,
            PolicyDocument=doc,
        )
        print(f"[LOCAL-TOKEN-DENY backup] attached → {role_name} ({reason})")
        return True
    except iam_client.exceptions.NoSuchEntityException:
        return False
    except Exception as e:
        print(f"[LOCAL-TOKEN-DENY backup] failed for {role_name}: {e}")
        return False


def _scan_limits_counters():
    """Return cumulative normalized usage keyed by (entity_type, key, period).
    entity_type ∈ {USER, DEPT}. We sum all COUNTER#{period}#... rows.
    """
    if limits_table is None:
        return {}
    totals = {}
    last_key = None
    pages = 0
    while True:
        params = {
            "FilterExpression": "begins_with(SK, :p)",
            "ExpressionAttributeValues": {":p": "COUNTER#"},
        }
        if last_key:
            params["ExclusiveStartKey"] = last_key
        try:
            r = limits_table.scan(**params)
        except Exception as e:
            print(f"[LIMITS] scan counters failed: {e}")
            return {}
        for item in r.get("Items", []):
            pk = item.get("PK", "")
            sk = item.get("SK", "")  # COUNTER#{period}#{bucket}
            parts = sk.split("#")
            if len(parts) < 3:
                continue
            period = parts[1]
            if pk.startswith("USER#"):
                key = ("USER", pk[5:], period)
            elif pk.startswith("DEPT#"):
                key = ("DEPT", pk[5:], period)
            else:
                continue
            totals[key] = totals.get(key, Decimal("0")) + Decimal(str(item.get("normalized", 0)))
        last_key = r.get("LastEvaluatedKey")
        pages += 1
        if not last_key or pages >= MAX_SCAN_PAGES:
            break
    return totals


def _scan_limits_limits():
    """Return per-(entity_type,key,period) max_normalized. Returns {} on failure."""
    if limits_table is None:
        return {}
    out = {}
    last_key = None
    pages = 0
    while True:
        params = {
            "FilterExpression": "begins_with(SK, :p)",
            "ExpressionAttributeValues": {":p": "LIMIT#"},
        }
        if last_key:
            params["ExclusiveStartKey"] = last_key
        try:
            r = limits_table.scan(**params)
        except Exception as e:
            print(f"[LIMITS] scan limits failed: {e}")
            return {}
        for item in r.get("Items", []):
            pk = item.get("PK", "")
            sk = item.get("SK", "")  # LIMIT#{period}
            parts = sk.split("#")
            if len(parts) < 2:
                continue
            period = parts[1]
            mx = Decimal(str(item.get("max_normalized", 0)))
            if mx <= 0:
                continue
            if pk.startswith("USER#"):
                out[("USER", pk[5:], period)] = mx
            elif pk.startswith("DEPT#"):
                out[("DEPT", pk[5:], period)] = mx
    return out


def check_token_limits_backup():
    """ADR-015: Backup token-limit check. Token-limit-enforcer Lambda (DDB Stream)
    is the primary; this 5-min cycle covers Stream consumer failures.

    Per ADR-015 §5: if cc-bedrock-local-token-deny is already attached, skip token
    check for that role (no duplicate attach).
    """
    counters = _scan_limits_counters()
    limits = _scan_limits_limits()
    if not counters or not limits:
        return {"attached": 0, "checked": 0, "skipped": 0}

    # Collect (entity_type, key) → first-tripped (period, used, max)
    tripped = {}
    for (etype, key, period), used in counters.items():
        mx = limits.get((etype, key, period))
        if mx and used >= mx:
            existing = tripped.get((etype, key))
            if not existing or used / mx > existing[1] / existing[2]:
                tripped[(etype, key)] = (period, used, mx)

    attached = 0
    skipped = 0
    checked = 0

    # USER trips → attach on the user's local role
    for (etype, key), (period, used, mx) in tripped.items():
        if etype != "USER":
            continue
        # Local role name pattern
        import re as _re
        role = f"{LOCAL_ROLE_PREFIX}{_re.sub(r'[^A-Za-z0-9_-]', '-', key)[:40]}"
        checked += 1
        if _has_local_token_deny(role):
            skipped += 1
            continue
        if _attach_local_token_deny(role, f"backup: USER {period} {used}/{mx}"):
            attached += 1

    # DEPT trips → attach on every local role in that dept (best-effort by listing)
    if tripped:
        dept_trips = {k: v for k, v in tripped.items() if k[0] == "DEPT"}
        if dept_trips:
            try:
                paginator = iam_client.get_paginator("list_roles")
                for page in paginator.paginate(PathPrefix="/"):
                    for role in page.get("Roles", []):
                        rname = role["RoleName"]
                        if not rname.startswith(LOCAL_ROLE_PREFIX):
                            continue
                        # read tags to find department
                        try:
                            tags_resp = iam_client.list_role_tags(RoleName=rname)
                            dept = next(
                                (t["Value"] for t in tags_resp.get("Tags", []) if t["Key"] == "department"),
                                None,
                            )
                        except Exception:
                            dept = None
                        if not dept:
                            continue
                        tr = dept_trips.get(("DEPT", dept))
                        if not tr:
                            continue
                        period, used, mx = tr
                        checked += 1
                        if _has_local_token_deny(rname):
                            skipped += 1
                            continue
                        if _attach_local_token_deny(rname, f"backup: DEPT {dept} {period} {used}/{mx}"):
                            attached += 1
            except Exception as e:
                print(f"[LIMITS] dept-wide list_roles failed: {e}")

    return {"attached": attached, "skipped": skipped, "checked": checked}


def set_cognito_budget_flag(username: str, exceeded: bool):
    """Set budget_exceeded flag in Cognito user attributes."""
    if not USER_POOL_ID:
        return
    try:
        result = cognito_client.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'custom:subdomain = "{username}"',
            Limit=1,
        )
        users = result.get("Users", [])
        if users:
            cognito_client.admin_update_user_attributes(
                UserPoolId=USER_POOL_ID,
                Username=users[0]["Username"],
                UserAttributes=[
                    {"Name": "custom:budget_exceeded", "Value": str(exceeded).lower()},
                ],
            )
    except Exception as e:
        print(f"Cognito update failed for {username}: {e}")


def check_department_budgets(user_spend):
    """Check department monthly budgets and return lists of warnings and over-budget depts."""
    dept_monthly = get_monthly_usage_by_department()
    dept_budgets = get_department_budgets()

    dept_warnings = []  # 80%+ but < 100%
    dept_over_budget = []  # 100%+

    for dept, data in dept_monthly.items():
        monthly_limit = _dept_total_budget(dept_budgets, dept)
        if monthly_limit <= 0:
            continue  # No limit set for this department

        pct = (data["cost"] / monthly_limit) * 100

        dept_info = {
            "department": dept,
            "cost": data["cost"],
            "limit": monthly_limit,
            "pct": pct,
            "users": list(data["users"]),
        }

        if pct >= 100:
            dept_over_budget.append(dept_info)
        elif pct >= 80:
            dept_warnings.append(dept_info)

    return dept_warnings, dept_over_budget


def handler(event, context):
    """Check budgets and enforce limits via per-user IAM Deny Policy."""
    # Reset per-invocation Local-role index so each 5-min run picks up newly issued/revoked roles.
    global _local_role_index, _local_role_index_built
    _local_role_index = {}
    _local_role_index_built = False

    user_spend = get_today_usage()
    all_known_users = set(user_spend.keys())
    user_budgets = get_user_budgets()
    dept_budgets = get_department_budgets()  # ADR-023: needed for perUserMonthlyBudget fallback
    over_budget = []
    warnings = []
    denied = 0
    released = 0

    # Write currentSpend to budget tables for dashboard display
    dept_monthly = get_monthly_usage_by_department()
    write_current_spend(user_spend, dept_monthly)

    # ─── Per-user daily budget check ───
    for user, data in user_spend.items():
        # ADR-023: user explicit > dept.perUserMonthlyBudget > global DAILY_BUDGET
        effective_budget = _effective_user_budget(user_budgets, dept_budgets, user, data["department"])
        pct = (data["cost"] / effective_budget) * 100 if effective_budget > 0 else 0

        if pct >= 100:
            over_budget.append({
                "user": user, "cost": data["cost"],
                "department": data["department"], "pct": pct,
            })
        elif pct >= 80:
            warnings.append({
                "user": user, "cost": data["cost"],
                "department": data["department"], "pct": pct,
            })

    # 80%: Send warning alert
    if warnings and SNS_TOPIC_ARN:
        msg = f"CC-on-Bedrock Budget Warnings (daily limit: ${DAILY_BUDGET}):\n\n"
        msg += "\n".join(
            f"- {w['user']} ({w['department']}): ${w['cost']:.4f} ({w['pct']:.1f}%)"
            for w in warnings
        )
        try:
            sns_client.publish(TopicArn=SNS_TOPIC_ARN, Subject="[CC-on-Bedrock] Budget Warning", Message=msg)
        except Exception as e:
            print(f"SNS warning failed: {e}")

    # 100%: Attach IAM Deny Policy + Cognito flag
    for item in over_budget:
        user = item["user"]
        print(f"OVER BUDGET: {user} ({item['department']}) ${item['cost']:.4f} ({item['pct']:.1f}%)")

        if attach_deny_policy(user):
            denied += 1
        set_cognito_budget_flag(user, True)

    if over_budget and SNS_TOPIC_ARN:
        msg = f"CC-on-Bedrock Budget EXCEEDED - Bedrock Access Denied:\n\n"
        msg += "\n".join(
            f"- {o['user']} ({o['department']}): ${o['cost']:.4f} ({o['pct']:.1f}% of ${DAILY_BUDGET})"
            for o in over_budget
        )
        try:
            sns_client.publish(TopicArn=SNS_TOPIC_ARN, Subject="[CC-on-Bedrock] Budget Exceeded - Access Denied", Message=msg)
        except Exception as e:
            print(f"SNS alert failed: {e}")

    # Release users who are NOT over budget but still have Deny Policy
    over_budget_users = {o["user"] for o in over_budget}
    for user in all_known_users:
        if user not in over_budget_users:
            if remove_deny_policy(user):
                released += 1
                set_cognito_budget_flag(user, False)

    # ─── Department monthly budget check ───
    dept_warnings, dept_over_budget = check_department_budgets(user_spend)
    dept_denied = 0
    dept_released = 0

    # Department 80%: Send warning alert
    if dept_warnings and SNS_TOPIC_ARN:
        msg = "CC-on-Bedrock DEPARTMENT Budget Warnings (monthly):\n\n"
        msg += "\n".join(
            f"- {d['department']}: ${d['cost']:.2f} / ${d['limit']:.2f} ({d['pct']:.1f}%) - {len(d['users'])} users"
            for d in dept_warnings
        )
        try:
            sns_client.publish(
                TopicArn=SNS_TOPIC_ARN,
                Subject="[CC-on-Bedrock] Department Budget Warning",
                Message=msg,
            )
        except Exception as e:
            print(f"SNS dept warning failed: {e}")

    # Department 100%: Block ALL users in department
    blocked_by_dept = set()
    for dept_info in dept_over_budget:
        print(f"DEPT OVER BUDGET: {dept_info['department']} ${dept_info['cost']:.2f} ({dept_info['pct']:.1f}%)")
        for user in dept_info["users"]:
            if attach_dept_deny_policy(user):
                dept_denied += 1
                blocked_by_dept.add(user)

    if dept_over_budget and SNS_TOPIC_ARN:
        msg = "CC-on-Bedrock DEPARTMENT Budget EXCEEDED - All Dept Users Blocked:\n\n"
        msg += "\n".join(
            f"- {d['department']}: ${d['cost']:.2f} / ${d['limit']:.2f} ({d['pct']:.1f}%) - {len(d['users'])} users blocked"
            for d in dept_over_budget
        )
        try:
            sns_client.publish(
                TopicArn=SNS_TOPIC_ARN,
                Subject="[CC-on-Bedrock] Department Budget Exceeded - Users Blocked",
                Message=msg,
            )
        except Exception as e:
            print(f"SNS dept alert failed: {e}")

    # Release dept deny for users whose department is now under budget
    over_budget_depts = {d["department"] for d in dept_over_budget}
    for user, data in user_spend.items():
        if data["department"] not in over_budget_depts and user not in blocked_by_dept:
            if remove_dept_deny_policy(user):
                dept_released += 1

    # ─── ADR-015: Local Governance token-limit backup check ───
    try:
        token_backup = check_token_limits_backup()
    except Exception as e:
        print(f"[LIMITS] backup check failed: {e}")
        token_backup = {"error": str(e)}

    return {
        "checked": len(user_spend),
        "over_budget": len(over_budget),
        "denied": denied,
        "released": released,
        "warnings": len(warnings),
        "daily_budget_usd": DAILY_BUDGET,
        "dept_warnings": len(dept_warnings),
        "dept_over_budget": len(dept_over_budget),
        "dept_denied": dept_denied,
        "dept_released": dept_released,
        "token_backup": token_backup,
        "timestamp": datetime.utcnow().isoformat(),
    }
