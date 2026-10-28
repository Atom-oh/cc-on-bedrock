"""
Budget Check Lambda (runs every 5 minutes)
Checks DynamoDB for users exceeding their daily / weekly / monthly USD budgets AND
department monthly budgets. Usage from every AI CLI (Claude Code, Codex — ADR-014)
counts, since both land in the same usage table.
Actions:
  Per-user USD budgets (ADR-008): three independent caps — daily (UTC day), weekly
  (ISO week, Mon 00:00 UTC) and monthly (calendar month, UTC). Exceeding ANY one blocks.
    80%: SNS warning alert
    100%: Attach IAM Deny Policy to per-user roles + Cognito flag + SNS alert
    Released automatically once every period is back under its cap (period rollover
    or a raised budget). Each cap resolves user value > dept per-user default > env.
  Department monthly budget:
    80%: SNS warning alert to dept managers
    100%: Block all department users via IAM Deny Policy
"""
from __future__ import annotations
import os
import json
import hashlib
import boto3
from datetime import datetime, timedelta, date
from decimal import Decimal


TABLE_NAME = os.environ.get("USAGE_TABLE_NAME", "cc-on-bedrock-usage")
DEPT_BUDGETS_TABLE = os.environ.get("DEPT_BUDGETS_TABLE", "cc-department-budgets")
USER_BUDGETS_TABLE = os.environ.get("USER_BUDGETS_TABLE", "cc-user-budgets")
LIMITS_TABLE = os.environ.get("LIMITS_TABLE", "cc-on-bedrock-limits")  # ADR-006 (legacy ADR-014)
ECS_CLUSTER = os.environ.get("ECS_CLUSTER_NAME", "cc-on-bedrock-devenv")
DAILY_BUDGET = float(os.environ.get("DAILY_BUDGET_USD", "50"))
# 0 = no global cap for that period (only user / dept per-user values apply).
WEEKLY_BUDGET = float(os.environ.get("WEEKLY_BUDGET_USD", "0"))
MONTHLY_BUDGET = float(os.environ.get("MONTHLY_BUDGET_USD", "0"))
BUDGET_PERIODS = ("daily", "weekly", "monthly")
_GLOBAL_BUDGETS = {"daily": DAILY_BUDGET, "weekly": WEEKLY_BUDGET, "monthly": MONTHLY_BUDGET}
USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "")
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
TASK_ROLE_PREFIX = "cc-on-bedrock-task"
LOCAL_ROLE_PREFIX = "cc-on-bedrock-local-user-"  # ADR-006 (legacy ADR-014) Local Governance Mode
MAX_SCAN_PAGES = 100
# ADR-015 canonical policy names (attach path). Legacy names below are still
# detached on every attach/remove so roles denied under the old names get
# migrated/released in place (ADR-020 runtime-upsert pattern — no one-shot script).
DENY_POLICY_NAME = "cc-bedrock-user-daily-deny"
DEPT_DENY_POLICY_NAME = "cc-bedrock-dept-budget-deny"
LOCAL_TOKEN_DENY_POLICY_NAME = "cc-bedrock-local-token-deny"
# Legacy (pre-ADR-015) policy names — delete-only, never attached anymore
LEGACY_DENY_POLICY_NAME = "BudgetExceededDeny"
LEGACY_DEPT_DENY_POLICY_NAME = "DeptBudgetExceededDeny"
# ADR-014 (amended 2026-10-26): Codex on bedrock-mantle (web search) is granted only to
# users whose cost is unlimited, because mantle traffic never reaches the invocation
# log and so is NOT metered. Every deny above also blocks mantle + web search.
MANTLE_DENY_ACTIONS = ("bedrock-mantle:*", "bedrock-websearch:*")
MANTLE_POLICY_NAME = "cc-bedrock-mantle-unmetered"
MANTLE_ENABLED = os.environ.get("MANTLE_ENABLED", "false").lower() == "true"
MANTLE_REGION = os.environ.get("MANTLE_REGION", "us-east-1")
ACCOUNT_ID = os.environ.get("ACCOUNT_ID", "")

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


# Set by get_user_period_usage when the scan stops at MAX_SCAN_PAGES; the handler then
# keeps existing denies instead of releasing them on incomplete totals (fail closed).
_usage_scan_truncated = False
# Set when a budget / limits read fails (those readers return {} on error, which is
# indistinguishable from "no caps"). The mantle grant fails safe on it: never grant
# unmetered access on partial data.
_budget_read_failed = False


def _mark_budget_read_failed(what: str):
    global _budget_read_failed
    _budget_read_failed = True
    print(f"[MANTLE] incomplete read: {what}")


def period_bounds(now: datetime | None = None) -> dict:
    """UTC period windows as {period: (start_date_str, next_reset_datetime)}.
    Usage rows are keyed `{YYYY-MM-DD}#{model}` by the invocation's UTC date."""
    now = now or datetime.utcnow()
    today = now.date()
    week_start = today - timedelta(days=today.weekday())  # ISO week: Monday
    month_start = today.replace(day=1)
    next_month = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)

    def at_midnight(d: date) -> datetime:
        return datetime(d.year, d.month, d.day)

    return {
        "daily": (today.isoformat(), at_midnight(today + timedelta(days=1))),
        "weekly": (week_start.isoformat(), at_midnight(week_start + timedelta(days=7))),
        "monthly": (month_start.isoformat(), at_midnight(next_month)),
    }


PERIODS = ("daily", "weekly", "monthly")


def period_key(period: str, now: datetime | None = None) -> str:
    """UTC key identifying the current window of `period`: day `YYYY-MM-DD`,
    ISO week `YYYY-Www` (ISO year), month `YYYY-MM`."""
    now = now or datetime.utcnow()
    if period == "daily":
        return now.date().isoformat()
    if period == "weekly":
        iso_year, iso_week, _ = now.isocalendar()
        return f"{iso_year}-W{iso_week:02d}"
    if period == "monthly":
        return f"{now.year:04d}-{now.month:02d}"
    raise ValueError(f"unknown period: {period}")


def cascade_targets(period: str, now: datetime | None = None) -> list[tuple[str, str]]:
    """[(period, key), ...] from the requested period up through monthly. A one-time
    grant raises its own window and every longer window that contains it."""
    return [(p, period_key(p, now)) for p in PERIODS[PERIODS.index(period):]]


def grant_attr(period: str, key: str) -> str:
    """Flat numeric attribute on the cc-user-budgets row (atomic DynamoDB ADD)."""
    return f"grant#{period}#{key}"


def active_grants(row: dict, now: datetime | None = None) -> dict:
    """{daily, weekly, monthly} grant amounts whose key matches the current window;
    grants for past windows are ignored."""
    return {
        p: float(row.get(grant_attr(p, period_key(p, now)), 0) or 0)
        for p in PERIODS
    }


def get_user_period_usage(now: datetime | None = None) -> dict:
    """Scan USER# usage rows from the earliest open period start through today and
    sum cost per user into daily / weekly / monthly buckets (with pagination).

    Returns {user: {"daily": $, "weekly": $, "monthly": $, "cost": today $, "department": str}}.
    `cost` mirrors the legacy today-only field used by callers/logs.
    """
    global _usage_scan_truncated
    _usage_scan_truncated = False
    bounds = period_bounds(now)
    today = bounds["daily"][0]
    scan_from = min(bounds["weekly"][0], bounds["monthly"][0])
    user_spend: dict = {}
    last_key = None
    pages = 0
    while True:
        params = {
            # Upper bound keeps non-usage rows under USER# (PROD#/SKILL#/… OTEL rollups,
            # whose SK sorts after any date) out of the window.
            "FilterExpression": "begins_with(PK, :prefix) AND SK BETWEEN :from AND :to",
            "ExpressionAttributeValues": {":prefix": "USER#", ":from": scan_from, ":to": today + "#\uffff"},
        }
        if last_key:
            params["ExclusiveStartKey"] = last_key
        result = table.scan(**params)
        for item in result.get("Items", []):
            user = item["PK"].replace("USER#", "").strip().lower()  # ADR-031: email
            if not _is_valid_user(user):
                continue  # stale non-Cognito identity (e.g. raw IAM principal) — skip
            row_date = str(item.get("SK", ""))[:10]
            cost = float(item.get("estimatedCost", 0))
            sd = item.get("subdomain")
            if sd:
                _subdomain_by_user[user] = sd  # for IAM role-name construction
            entry = user_spend.setdefault(user, {
                "daily": 0.0, "weekly": 0.0, "monthly": 0.0, "cost": 0.0,
                "department": "default", "_dept_date": "",
            })
            # Scan order is arbitrary: take the department from the most recent row.
            dept = item.get("department")
            if dept and row_date >= entry["_dept_date"]:
                entry["department"] = dept
                entry["_dept_date"] = row_date
            if row_date == today:
                entry["daily"] += cost
                entry["cost"] += cost
            if row_date >= bounds["weekly"][0]:
                entry["weekly"] += cost
            if row_date >= bounds["monthly"][0]:
                entry["monthly"] += cost
        last_key = result.get("LastEvaluatedKey")
        pages += 1
        if not last_key:
            break
        if pages >= MAX_SCAN_PAGES:
            _usage_scan_truncated = True
            print("[BUDGET] usage scan truncated at MAX_SCAN_PAGES — totals may be under-counted; "
                  "existing denies are kept (fail closed)")
            break
    for entry in user_spend.values():
        entry.pop("_dept_date", None)
    return user_spend


def get_today_usage():
    """Back-compat: {user: {"cost": today $, "department": str}} (today = UTC day)."""
    return {u: {"cost": d["daily"], "department": d["department"]}
            for u, d in get_user_period_usage().items()}


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
            user = item["PK"].replace("USER#", "").strip().lower()  # ADR-031: email
            if not _is_valid_user(user):
                continue  # stale non-Cognito identity — skip
            cost = float(item.get("estimatedCost", 0))
            dept = item.get("department", "default")
            sd = item.get("subdomain")
            if sd:
                _subdomain_by_user[user] = sd
            if dept in dept_spend:
                dept_spend[dept]["cost"] += cost
                dept_spend[dept]["users"].add(user)
            else:
                dept_spend[dept] = {"cost": cost, "users": {user}}
        last_key = result.get("LastEvaluatedKey")
        pages += 1
        if last_key and pages >= MAX_SCAN_PAGES:
            global _usage_scan_truncated
            _usage_scan_truncated = True
            print("[BUDGET] dept usage scan truncated at MAX_SCAN_PAGES — dept denies kept (fail closed)")
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
                    "perUserDailyBudget": float(item.get("perUserDailyBudget", 0) or 0),
                    "perUserWeeklyBudget": float(item.get("perUserWeeklyBudget", 0) or 0),
                    "perUserMonthlyBudget": float(item.get("perUserMonthlyBudget", 0) or 0),
                }
            last_key = result.get("LastEvaluatedKey")
            pages += 1
            if not last_key or pages >= MAX_SCAN_PAGES:
                break
        if last_key:
            _mark_budget_read_failed("department budgets scan truncated")
        return budgets
    except Exception as e:
        _mark_budget_read_failed("department budgets")
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


def _effective_user_limits(user_budgets: dict, dept_budgets: dict, user: str, dept: str,
                           now: datetime | None = None) -> dict:
    """ADR-008: per-period USD caps {daily, weekly, monthly}; 0 = no cap for that period.
    Each period resolves independently: user explicit > dept per-user default > global env.
    Active one-time grants (u["grants"], computed once per scan by get_user_budgets) are
    added only to a capped period; an uncapped period (0) stays unlimited. `now` is
    accepted for interface symmetry; grant windows are already resolved at scan time."""
    u = user_budgets.get(user, {}) or {}
    d = dept_budgets.get(dept) if isinstance(dept_budgets.get(dept), dict) else {}
    limits = {}
    for period in BUDGET_PERIODS:
        cap = period.capitalize()  # daily → Daily
        base = (
            float(u.get(f"{period}Budget", 0) or 0)
            or float(d.get(f"perUser{cap}Budget", 0) or 0)
            or float(_GLOBAL_BUDGETS[period])
        )
        grant = float((u.get("grants") or {}).get(period, 0) or 0)
        limits[period] = base + grant if base > 0 else 0.0
    return limits


def _effective_user_budget(user_budgets: dict, dept_budgets: dict, user: str, dept: str) -> float:
    """Back-compat accessor: the effective DAILY cap."""
    return _effective_user_limits(user_budgets, dept_budgets, user, dept)["daily"]


def evaluate_user_budget(spend: dict, limits: dict, now: datetime | None = None) -> dict:
    """Pure: which periods are exceeded / at warning level, the max utilization, and
    when the deny can lift (latest reset among exceeded periods — all must clear)."""
    bounds = period_bounds(now)
    exceeded, warned, pct = [], [], 0.0
    for period in BUDGET_PERIODS:
        cap = limits.get(period, 0) or 0
        if cap <= 0:
            continue
        p = (spend.get(period, 0.0) / cap) * 100
        pct = max(pct, p)
        if p >= 100:
            exceeded.append(period)
        elif p >= 80:
            warned.append(period)
    release_at = max((bounds[p][1] for p in exceeded), default=None)
    return {
        "exceeded": exceeded,
        "warned": warned,
        "pct": pct,
        "release_at": release_at.strftime("%Y-%m-%dT%H:%M:%SZ") if release_at else "",
    }


def get_user_budgets():
    """Fetch per-user budget limits from cc-user-budgets table."""
    try:
        budgets = {}
        last_key = None
        pages = 0
        now = datetime.utcnow()  # one clock for every row's grant window this scan
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
                        "dailyBudget": float(item.get("dailyBudget", 0) or 0),
                        "weeklyBudget": float(item.get("weeklyBudget", 0) or 0),
                        "monthlyBudget": float(item.get("monthlyBudget", 0) or 0),
                        "department": item.get("department", "default"),
                        "blocked": bool(item.get("budgetExceeded")),
                        "grants": active_grants(item, now),
                    }
            last_key = result.get("LastEvaluatedKey")
            pages += 1
            if not last_key or pages >= MAX_SCAN_PAGES:
                break
        if last_key:
            _mark_budget_read_failed("user budgets scan truncated")
        return budgets
    except Exception as e:
        _mark_budget_read_failed("user budgets")
        print(f"[USER-BUDGETS] Failed to fetch user budgets: {e}")
        return {}


def write_current_spend(user_spend, dept_spend):
    """Write computed currentSpend back to budget tables for dashboard display."""
    now = datetime.utcnow().isoformat()

    # Write per-user spend to cc-user-budgets. currentSpend = month-to-date (the
    # admin UI compares it with monthlyBudget); per-period spend + the evaluation
    # (exceeded periods, release time) drive the dashboard / Local Mode status.
    for user, data in user_spend.items():
        try:
            ev = data.get("evaluation") or {}
            limits = data.get("limits") or {}
            grants = data.get("grants") or {}
            user_budgets_table.update_item(
                Key={"user_id": user},
                UpdateExpression=(
                    "SET currentSpend = :spend, currentDailySpend = :d, currentWeeklySpend = :w, "
                    "currentMonthlySpend = :m, effectiveDailyBudget = :ld, effectiveWeeklyBudget = :lw, "
                    "effectiveMonthlyBudget = :lm, budgetExceeded = :ex, budgetReleaseAt = :rel, "
                    "lastChecked = :ts, department = :dept, activeGrantDaily = :gd, "
                    "activeGrantWeekly = :gw, activeGrantMonthly = :gm"
                ),
                ExpressionAttributeValues={
                    ":spend": Decimal(str(round(data.get("monthly", data["cost"]), 6))),
                    ":d": Decimal(str(round(data.get("daily", data["cost"]), 6))),
                    ":w": Decimal(str(round(data.get("weekly", 0.0), 6))),
                    ":m": Decimal(str(round(data.get("monthly", 0.0), 6))),
                    ":ld": Decimal(str(limits.get("daily", 0))),
                    ":lw": Decimal(str(limits.get("weekly", 0))),
                    ":lm": Decimal(str(limits.get("monthly", 0))),
                    ":ex": list(ev.get("exceeded", [])),
                    ":rel": ev.get("release_at", ""),
                    ":ts": now,
                    ":dept": data["department"],
                    ":gd": Decimal(str(grants.get("daily", 0))),
                    ":gw": Decimal(str(grants.get("weekly", 0))),
                    ":gm": Decimal(str(grants.get("monthly", 0))),
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


# ADR-031 (B′): per-handler map of email → subdomain, populated from the
# `subdomain` attribute on usage rows during get_today_usage / monthly scans.
# Lets _candidate_role_names build BOTH IAM role names (local-user-{subdomain},
# task-{subdomain}) for an email-keyed user. Reset at handler entry.
_subdomain_by_user: dict = {}

# Set of identifiers that belong to a real Cognito user (sub + custom:subdomain +
# email + username). Usage rows keyed by anything else — e.g. a raw IAM principal
# like "awsops-ec2-role" written before the bedrock-usage-tracker role filter
# existed — are stale and must be ignored so they never reach cc-user-budgets or
# the deny logic. Populated at handler entry; empty means "could not load" →
# fail-open (do not filter) so a transient Cognito error can't zero all spend or
# release every deny policy.
_valid_user_keys: set = set()
# {email: subdomain} built from the SAME Cognito scan as _valid_user_keys (see below). Used by the
# release path to resolve idle/denied users' Local role without an N+1 per-user ListUsers.
_email_subdomain_map: dict = {}
# {email: custom:department} from the same scan (mantle eligibility needs every user's dept).
_email_dept_map: dict = {}


def _load_valid_user_keys() -> set:
    """Build the set of authoritative Cognito identifiers (sub / subdomain / email /
    username). Returns an empty set on any failure so callers fail open.

    Side effect: rebuilds the module-level _email_subdomain_map {email: subdomain} from the SAME
    single paginated scan. The release path needs subdomains for denied/idle users (no usage row
    this period) to detach their Deny; doing it from this one scan avoids a per-user ListUsers
    (N+1 → Cognito throttle at scale → release failures) — PR #68 review.
    """
    global _email_subdomain_map, _email_dept_map
    _email_subdomain_map = {}
    _email_dept_map = {}
    keys: set = set()
    if not USER_POOL_ID:
        return keys
    try:
        pagination_token = None
        pages = 0
        while True:
            params = {"UserPoolId": USER_POOL_ID, "Limit": 60}
            if pagination_token:
                params["PaginationToken"] = pagination_token
            result = cognito_client.list_users(**params)
            for u in result.get("Users", []):
                if u.get("Username"):
                    keys.add(u["Username"].strip().lower())
                u_email = u_subdomain = None
                u_dept = "default"
                for attr in u.get("Attributes", []):
                    # ADR-031: canonical key is email; lowercase all keys so a
                    # mixed-case email row (USER#{email.lower()}) still matches.
                    if attr["Name"] in ("sub", "custom:subdomain", "email") and attr.get("Value"):
                        keys.add(attr["Value"].strip().lower())
                    if attr["Name"] == "email" and attr.get("Value"):
                        u_email = attr["Value"].strip().lower()
                    elif attr["Name"] == "custom:subdomain" and attr.get("Value"):
                        u_subdomain = attr["Value"].strip()
                    elif attr["Name"] == "custom:department" and attr.get("Value"):
                        u_dept = attr["Value"].strip()
                if u_email and u_subdomain:
                    _email_subdomain_map[u_email] = u_subdomain
                    _email_dept_map[u_email] = u_dept
            pagination_token = result.get("PaginationToken")
            pages += 1
            if not pagination_token or pages >= MAX_SCAN_PAGES:
                break
        if pagination_token:
            _mark_budget_read_failed("Cognito user scan truncated")
    except Exception as e:
        _mark_budget_read_failed("Cognito users")
        print(f"[VALID-USERS] Failed to load Cognito users (failing open): {e}")
        return set()
    return keys


def _is_valid_user(key: str) -> bool:
    """True if `key` belongs to a Cognito user. Fail-open when the valid-key set
    could not be loaded (empty), so a Cognito hiccup never drops real spend."""
    if not _valid_user_keys:
        return True
    return (key or "").strip().lower() in _valid_user_keys


def _candidate_role_names(user: str) -> list:
    """Return all IAM role candidates for a user (Local Governance + EC2 task).

    ADR-031 (B′): usage/limits rows are keyed by email, and ALL IAM role names use
    the subdomain. Both `cc-on-bedrock-local-user-{subdomain}` and
    `cc-on-bedrock-task-{subdomain}` use the current Cognito subdomain when known.
    Historical usage metadata is only a fallback: monthly scans can include an
    obsolete subdomain and return rows in arbitrary order.
    The email is NEVER used as a role name
    suffix (`local-user-{email}` would be a wrong/non-existent role → fail-safe).
    """
    subdomain = _email_subdomain_map.get(user) or _subdomain_by_user.get(user)
    if not subdomain:
        # No subdomain known → cannot construct a valid role name. Fail-safe: emit
        # nothing rather than local-user-{email}.
        return []
    return [
        f"{LOCAL_ROLE_PREFIX}{subdomain}",
        f"{TASK_ROLE_PREFIX}-{subdomain}",
    ]


def attach_dept_deny_policy(subdomain: str):
    """Attach department budget exceeded IAM Deny Policy.
    ADR-015 §3: applies to BOTH the per-user EC2 Task Role and any Local Governance role
    whose `username` tag matches the subdomain.
    """
    deny_policy = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "CcBedrockDeptBudgetDeny",
            "Effect": "Deny",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
                "bedrock:Converse",
                "bedrock:ConverseStream",
                *MANTLE_DENY_ACTIONS,
            ],
            "Resource": "*",
        }],
    })
    role_names = _candidate_role_names(subdomain)
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
            _delete_policy_quiet(role_name, LEGACY_DEPT_DENY_POLICY_NAME)  # ADR-015: migrate legacy name in place
        except iam_client.exceptions.NoSuchEntityException:
            # EC2 task role may not exist for a Local-only user — silently skip.
            continue
        except Exception as e:
            print(f"[DEPT-DENY] Failed for {role_name}: {e}")
    return any_attached


def remove_dept_deny_policy(subdomain: str):
    """Remove department budget IAM Deny Policy (canonical + legacy names) from both
    EC2 Task Role and matching Local roles."""
    role_names = _candidate_role_names(subdomain)
    any_removed = False
    for role_name in role_names:
        for policy_name in (DEPT_DENY_POLICY_NAME, LEGACY_DEPT_DENY_POLICY_NAME):
            try:
                iam_client.delete_role_policy(
                    RoleName=role_name,
                    PolicyName=policy_name,
                )
                print(f"[DEPT-ALLOW] Removed {policy_name} from {role_name}")
                any_removed = True
            except iam_client.exceptions.NoSuchEntityException:
                continue
            except Exception as e:
                print(f"[DEPT-ALLOW] Failed for {role_name}/{policy_name}: {e}")
    return any_removed


def _delete_policy_quiet(role_name: str, policy_name: str):
    """Best-effort delete of an inline policy — used to clean up legacy (pre-ADR-015)
    policy names whenever the canonical name is attached or released."""
    try:
        iam_client.delete_role_policy(RoleName=role_name, PolicyName=policy_name)
        print(f"[MIGRATE] Removed legacy {policy_name} from {role_name}")
    except Exception:
        pass  # not present / role gone — nothing to migrate


def attach_deny_policy(subdomain: str):
    """Attach the user daily-budget deny (cc-bedrock-user-daily-deny, ADR-015) to ALL
    of the user's roles (EC2 task + Local Governance).

    Previously this only tried the EC2 `cc-on-bedrock-task-{subdomain}` role, so Local-only
    users (whose role is `cc-on-bedrock-local-user-{subdomain}`) silently bypassed the
    daily/monthly $ budget enforcement. Both role names are now built from the usage row's
    `subdomain` attribute via `_candidate_role_names` (ADR-031). NOTE: the `subdomain` param
    is actually the email user-key (the map is email-keyed) — misnamed, not a bug.
    """
    deny_policy = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "CcBedrockUserDailyDeny",
            "Effect": "Deny",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
                "bedrock:Converse",
                "bedrock:ConverseStream",
                *MANTLE_DENY_ACTIONS,
            ],
            "Resource": "*",
        }],
    })
    role_names = _candidate_role_names(subdomain)
    any_attached = False
    for role_name in role_names:
        try:
            iam_client.put_role_policy(
                RoleName=role_name,
                PolicyName=DENY_POLICY_NAME,
                PolicyDocument=deny_policy,
            )
            print(f"[DENY] Attached to {role_name}")
            any_attached = True
            _delete_policy_quiet(role_name, LEGACY_DENY_POLICY_NAME)  # ADR-015: migrate legacy name in place
        except iam_client.exceptions.NoSuchEntityException:
            # EC2 task role may not exist for a Local-only user — skip silently.
            continue
        except Exception as e:
            print(f"[DENY] Failed for {role_name}: {e}")
    return any_attached


def remove_deny_policy(subdomain: str):
    """Remove the user daily-budget deny (canonical + legacy names) from ALL of the
    user's roles (EC2 task + Local)."""
    role_names = _candidate_role_names(subdomain)
    any_removed = False
    for role_name in role_names:
        for policy_name in (DENY_POLICY_NAME, LEGACY_DENY_POLICY_NAME):
            try:
                iam_client.delete_role_policy(
                    RoleName=role_name,
                    PolicyName=policy_name,
                )
                print(f"[ALLOW] Removed {policy_name} from {role_name}")
                any_removed = True
            except iam_client.exceptions.NoSuchEntityException:
                continue
            except Exception as e:
                print(f"[ALLOW] Failed for {role_name}/{policy_name}: {e}")
    return any_removed


def check_deny_exists(subdomain: str) -> bool:
    """Return True if the user daily-budget deny (canonical or legacy name) is present
    on ANY of the user's roles."""
    role_names = _candidate_role_names(subdomain)
    for role_name in role_names:
        for policy_name in (DENY_POLICY_NAME, LEGACY_DENY_POLICY_NAME):
            try:
                iam_client.get_role_policy(
                    RoleName=role_name,
                    PolicyName=policy_name,
                )
                return True
            except Exception:
                continue
    return False


# ──────────────────────────────────────────────────────────
# ADR-006 (legacy ADR-014) / ADR-015 — Local Governance Mode helpers
# ──────────────────────────────────────────────────────────



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
                *MANTLE_DENY_ACTIONS,
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
            _mark_budget_read_failed("limits")
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
        last_key = r.get("LastEvaluatedKey")
        pages += 1
        if not last_key or pages >= MAX_SCAN_PAGES:
            break
    if last_key:
        _mark_budget_read_failed("limits scan truncated")
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

    # USER trips → attach on the user's local role.
    # `key` comes from cc-on-bedrock-limits PK suffix, which the Stream
    # producer (bedrock-usage-tracker) keys by Cognito *username* — NOT the
    # sub UUID embedded in the real role name. Resolve via the username tag
    # reverse index; no naive-format fallback because that's the broken
    # pattern this whole module-level helper exists to replace.
    for (etype, key), (period, used, mx) in tripped.items():
        if etype != "USER":
            continue
        # ADR-031: `key` is the canonical email; `_candidate_role_names` resolves the
        # row's `subdomain` (captured during the usage scan) to build both the Local
        # and EC2 task role names.
        candidate_roles = _candidate_role_names(key)
        for role in candidate_roles:
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


# ──────────────────────────────────────────────────────────
# ADR-014 (amended 2026-10-26): Codex on bedrock-mantle for unlimited users
# ──────────────────────────────────────────────────────────

def mantle_eligible(user: str, dept: str, user_budgets: dict, dept_budgets: dict, token_limits: dict,
                    aliases: tuple = ()) -> bool:
    """Pure: True only when no cap of any kind applies to the user — every effective
    USD cap (user > dept per-user default > global) is 0, the department has no total
    budget, and no token LIMIT# row exists for the user or the department.

    Keys are compared lowercased, and `aliases` (e.g. the legacy subdomain key) plus the
    department recorded on any of the user's budget rows are checked too: a cap row that
    cannot be matched exactly must still make the user ineligible (never fail open)."""
    norm = lambda k: (k or "").strip().lower()
    keys = {norm(user), *(norm(a) for a in aliases if a)}
    # Every row under any spelling counts (keys differing only in case must not shadow each other).
    rows = [v for k, v in user_budgets.items() if norm(k) in keys]
    depts = {norm(dept) or "default", *(norm(r.get("department")) for r in rows if r.get("department"))}
    dept_rows = [v for k, v in dept_budgets.items() if norm(k) in depts] or [{}]
    for row in rows or [{}]:
        for d_row in dept_rows:
            limits = _effective_user_limits({"u": row}, {"d": d_row}, "u", "d")
            if any(v > 0 for v in limits.values()) or _dept_total_budget({"d": d_row}, "d") > 0:
                return False
    return not any((etype == "USER" and norm(key) in keys) or (etype == "DEPT" and norm(key) in depts)
                   for etype, key, _period in token_limits)


def mantle_policy_doc(project_id: str) -> str:
    """The per-user grant: inference on the user's OWN project only (so the
    OpenAI-Project header is mandatory — project/default is AccessDenied) + web search."""
    return json.dumps({
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "MantleOwnProjectUnmetered",
                "Effect": "Allow",
                "Action": ["bedrock-mantle:CreateInference", "bedrock-mantle:Get*", "bedrock-mantle:List*"],
                "Resource": f"arn:aws:bedrock-mantle:{MANTLE_REGION}:{ACCOUNT_ID}:project/{project_id}",
            },
            {
                "Sid": "MantleWebSearch",
                "Effect": "Allow",
                "Action": ["bedrock-websearch:InvokeSearch", "bedrock-websearch:InvokeFetch"],
                "Resource": "*",
            },
        ],
    }, separators=(",", ":"))


def _mantle_request(method: str, path: str, body: dict | None = None) -> dict:
    """SigV4-signed call to the mantle control plane (no boto3 client exists for it)."""
    import urllib.error
    import urllib.request
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    url = f"https://bedrock-mantle.{MANTLE_REGION}.api.aws{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = AWSRequest(method=method, url=url, data=data, headers={"Content-Type": "application/json"})
    creds = boto3.Session().get_credentials().get_frozen_credentials()
    SigV4Auth(creds, "bedrock-mantle", MANTLE_REGION).add_auth(req)
    r = urllib.request.Request(url, data=data, headers=dict(req.headers), method=method)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"mantle {method} {path.split('?')[0]} → {e.code}: {e.read()[:300]!r}") from e


def mantle_project_name(subdomain: str) -> str:
    return f"cc-{subdomain}"[:64]


def list_mantle_projects() -> list:
    """Active projects as [{id, name, tags}]."""
    out, after = [], None
    for _ in range(MAX_SCAN_PAGES):
        q = "?limit=100" + (f"&after={after}" if after else "")
        page = _mantle_request("GET", f"/v1/organization/projects{q}")
        for p in page.get("data", []):
            if p.get("status", "active") == "active" and p.get("name"):
                out.append({"id": p["id"], "name": p["name"], "tags": p.get("tags") or {}})
        if not page.get("has_more"):
            break
        after = page.get("last_id")
    return out


def ensure_mantle_project(subdomain: str, email: str, projects: list) -> str:
    """Reuse the user's project or create it. Ownership is checked by tag (never by
    name alone), so a reassigned subdomain never inherits another user's project.
    Projects are never archived here, so history stays attributable across
    revoke/grant cycles."""
    name = mantle_project_name(subdomain)
    owned = [p for p in projects
             if (p.get("tags") or {}).get("cc-on-bedrock:managed") == "true"
             and str((p.get("tags") or {}).get("cc-on-bedrock:user", "")).lower() == email.lower()]
    if owned:
        return next((p for p in owned if p["name"] == name), owned[0])["id"]
    if any(p["name"] == name for p in projects):
        # Name taken by another owner: suffix with an email hash.
        name = f"cc-{subdomain}"[:55] + "-" + hashlib.sha256(email.lower().encode()).hexdigest()[:8]
    tags = {"cc-on-bedrock:user": email, "cc-on-bedrock:managed": "true"}
    created = _mantle_request("POST", "/v1/organization/projects", {"name": name, "tags": tags})
    projects.append({"id": created["id"], "name": name, "tags": tags})
    print(f"[MANTLE] created project {created['id']} ({name}) for {email}")
    return created["id"]


def _current_inline(role_name: str, policy_name: str):
    """Policy document (as dict) or None when absent."""
    try:
        doc = iam_client.get_role_policy(RoleName=role_name, PolicyName=policy_name)["PolicyDocument"]
    except iam_client.exceptions.NoSuchEntityException:
        return None
    if isinstance(doc, str):
        from urllib.parse import unquote
        doc = json.loads(unquote(doc))
    return doc


def _revoke_mantle(role_name: str) -> bool:
    # Read first: this runs for every ineligible user each cycle and reads are far
    # cheaper on the IAM rate limit than a blind DeleteRolePolicy.
    try:
        if _current_inline(role_name, MANTLE_POLICY_NAME) is None:
            return False
        iam_client.delete_role_policy(RoleName=role_name, PolicyName=MANTLE_POLICY_NAME)
        print(f"[MANTLE] revoked → {role_name}")
        return True
    except iam_client.exceptions.NoSuchEntityException:
        return False


def _local_roles() -> list:
    names = []
    for page in iam_client.get_paginator("list_roles").paginate(PathPrefix="/"):
        names += [r["RoleName"] for r in page.get("Roles", []) if r["RoleName"].startswith(LOCAL_ROLE_PREFIX)]
    return names


def _revoke_mantle_except(keep: set) -> int:
    """Revoke from every Local role not in `keep` — including roles whose user is gone
    from Cognito (a deprovisioned user must not keep an unmetered grant)."""
    revoked = 0
    for role in _local_roles():
        if role in keep:
            continue
        try:
            revoked += _revoke_mantle(role)
        except Exception as e:
            print(f"[MANTLE] revoke failed for {role}: {e}")
    return revoked


def reconcile_mantle(user_budgets: dict, dept_budgets: dict) -> dict:
    """Grant mantle to unlimited users, revoke it from every other Local role (≤ 5 min
    after a cap appears). Local Mode roles only; EC2 DevEnv is a follow-up."""
    if not MANTLE_ENABLED:
        return {"enabled": False}
    token_limits = _scan_limits_limits()
    if _budget_read_failed or limits_table is None or not _email_subdomain_map or not ACCOUNT_ID:
        print("[MANTLE] incomplete budget/limits/Cognito data — revoking all grants (fail safe)")
        return {"enabled": True, "failsafe": True, "revoked": _revoke_mantle_except(set())}

    eligible = {e: sd for e, sd in _email_subdomain_map.items()
                if mantle_eligible(e, _email_dept_map.get(e, "default"), user_budgets, dept_budgets,
                                   token_limits, aliases=(sd,))}
    # A subdomain shared by several Cognito users would share one role: grant only if all are eligible.
    by_role: dict = {}
    for e, sd in _email_subdomain_map.items():
        by_role.setdefault(f"{LOCAL_ROLE_PREFIX}{sd}", []).append(e)
    grant_roles = {r: es[0] for r, es in by_role.items() if len(es) == 1 and es[0] in eligible}
    revoked = _revoke_mantle_except(set(grant_roles))
    projects = None
    granted = 0
    for role, email in grant_roles.items():
        subdomain = eligible[email]
        try:
            iam_client.list_role_tags(RoleName=role)  # NoSuchEntity → no Local role, no project
            if projects is None:
                projects = list_mantle_projects()
            doc = mantle_policy_doc(ensure_mantle_project(subdomain, email, projects))
            if _current_inline(role, MANTLE_POLICY_NAME) != json.loads(doc):
                iam_client.put_role_policy(RoleName=role, PolicyName=MANTLE_POLICY_NAME, PolicyDocument=doc)
                granted += 1
                print(f"[MANTLE] granted (unmetered) → {role}")
        except iam_client.exceptions.NoSuchEntityException:
            continue  # user has not used Local Mode yet: no role to grant on
        except Exception as e:
            # Fail safe: the existing grant may point at a previous owner's project (the
            # subdomain was reassigned) and ownership could not be verified, so drop it.
            # The next run re-grants once the mantle API answers.
            print(f"[MANTLE] reconcile failed for {email}: {e}")
            try:
                revoked += _revoke_mantle(role)
            except Exception as e2:
                print(f"[MANTLE] revoke failed for {role}: {e2}")
    return {"enabled": True, "eligible": len(grant_roles), "granted": granted, "revoked": revoked}


def set_cognito_budget_flag(user: str, exceeded: bool):
    """Set budget_exceeded flag in Cognito user attributes.

    ADR-031 (B′): callers pass the canonical key = email. `email` is a supported
    ListUsers filter attribute, so we filter by it directly (the old `sub` filter
    would match nothing now that PKs are emails).
    """
    if not USER_POOL_ID:
        return
    email = (user or "").strip().lower()
    try:
        result = cognito_client.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'email = "{email}"',
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
        print(f"Cognito update failed for {email}: {e}")


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
    # ADR-031: reset the per-invocation email→subdomain map (repopulated by the scans).
    global _subdomain_by_user, _valid_user_keys, _budget_read_failed
    _subdomain_by_user = {}
    _budget_read_failed = False  # before any reader below can set it
    # Load the authoritative Cognito identity set so the scans below skip stale
    # non-user rows (e.g. raw IAM principals). Empty set = fail-open (no filtering).
    _valid_user_keys = _load_valid_user_keys()
    print(f"[VALID-USERS] loaded {len(_valid_user_keys)} Cognito identity keys")

    user_spend = get_user_period_usage()
    all_known_users = set(user_spend.keys())
    user_budgets = get_user_budgets()
    dept_budgets = get_department_budgets()  # ADR-023: dept per-user defaults
    over_budget = []
    warnings = []
    denied = 0
    released = 0

    # ─── Per-user daily / weekly / monthly budget check (ADR-008) ───
    for user, data in user_spend.items():
        limits = _effective_user_limits(user_budgets, dept_budgets, user, data["department"])
        ev = evaluate_user_budget(data, limits)
        data["limits"], data["evaluation"] = limits, ev
        data["grants"] = (user_budgets.get(user) or {}).get("grants", {})
        entry = {
            "user": user, "department": data["department"], "pct": ev["pct"],
            "spend": {p: data[p] for p in BUDGET_PERIODS}, "limits": limits,
        }
        if ev["exceeded"]:
            over_budget.append({**entry, "periods": ev["exceeded"], "release_at": ev["release_at"]})
        elif ev["warned"]:
            warnings.append({**entry, "periods": ev["warned"]})

    # Budgeted users with no usage in the scan window (e.g. after a period rollover) get a
    # zero-spend evaluation written too — otherwise a stale budgetExceeded keeps rendering
    # them as BLOCKED after the deny was released. Only rows that currently show a block
    # are rewritten, to keep writes bounded. Skipped on a truncated scan (fail closed).
    if not _usage_scan_truncated:
        for user, b in user_budgets.items():
            if user in user_spend or not b.get("blocked"):
                continue
            stale = {"daily": 0.0, "weekly": 0.0, "monthly": 0.0, "cost": 0.0,
                     "department": b.get("department", "default")}
            stale["limits"] = _effective_user_limits(user_budgets, dept_budgets, user, stale["department"])
            stale["evaluation"] = evaluate_user_budget(stale, stale["limits"])
            stale["grants"] = b.get("grants", {})
            user_spend[user] = stale

    # Write per-period spend + evaluation to budget tables for dashboard display. A
    # truncated scan writes nothing: partial totals must not flip a shown block to OK
    # while the IAM deny stays attached (fail closed).
    dept_monthly = get_monthly_usage_by_department()
    if _usage_scan_truncated:
        print("[BUDGET] skipping budget-table writes this run: usage scan was truncated")
    else:
        write_current_spend(user_spend, dept_monthly)

    def _fmt(o):
        return ", ".join(f"{p} ${o['spend'][p]:.2f}/${o['limits'][p]:.2f}" for p in o["periods"])

    # 80%: Send warning alert
    if warnings and SNS_TOPIC_ARN:
        msg = "CC-on-Bedrock Budget Warnings (>=80% of a daily/weekly/monthly cap):\n\n"
        msg += "\n".join(
            f"- {w['user']} ({w['department']}): {_fmt(w)} ({w['pct']:.1f}%)"
            for w in warnings
        )
        try:
            sns_client.publish(TopicArn=SNS_TOPIC_ARN, Subject="[CC-on-Bedrock] Budget Warning", Message=msg)
        except Exception as e:
            print(f"SNS warning failed: {e}")

    # 100%: Attach IAM Deny Policy + Cognito flag
    for item in over_budget:
        user = item["user"]
        print(f"OVER BUDGET: {user} ({item['department']}) {_fmt(item)} ({item['pct']:.1f}%) until {item['release_at']}")

        if attach_deny_policy(user):
            denied += 1
        set_cognito_budget_flag(user, True)

    if over_budget and SNS_TOPIC_ARN:
        msg = f"CC-on-Bedrock Budget EXCEEDED - Bedrock Access Denied:\n\n"
        msg += "\n".join(
            f"- {o['user']} ({o['department']}): {_fmt(o)} — blocked until {o['release_at']}"
            for o in over_budget
        )
        try:
            sns_client.publish(TopicArn=SNS_TOPIC_ARN, Subject="[CC-on-Bedrock] Budget Exceeded - Access Denied", Message=msg)
        except Exception as e:
            print(f"SNS alert failed: {e}")

    # Release users who are NOT over budget but still have a Deny policy.
    # Bugfix (deny deadlock): a denied user can't invoke Bedrock → has no usage
    # today → never appears in all_known_users → their Deny was never removed even
    # after the budget was raised. Iterate users that have a budget row too
    # (idle/denied users persist there). remove_deny_policy is a no-op
    # (NoSuchEntity) when no Deny is attached, so this is safe.
    # NOTE (scale): this attempts a removal for every budget-tracked user each run.
    # Fine for dozens of users; for very large fleets, gate on a `denied` marker.
    over_budget_users = {o["user"] for o in over_budget}
    release_candidates = all_known_users | set(user_budgets.keys())
    if _usage_scan_truncated:
        # Incomplete totals must never lift a deny (fail closed).
        print("[BUDGET] skipping deny release this run: usage scan was truncated")
        release_candidates = set()
    for user in release_candidates:
        if user not in over_budget_users:
            # Deny-deadlock fix (PR #68 review): a denied/idle user isn't in the usage scans, so
            # its subdomain may be absent from _subdomain_by_user → _candidate_role_names would
            # no-op and the Deny would never detach. Backfill from the one-shot _email_subdomain_map
            # (built by _load_valid_user_keys in a single scan) — no per-user ListUsers.
            if not _subdomain_by_user.get(user) and "@" in user:
                sd = _email_subdomain_map.get(user)
                if sd:
                    _subdomain_by_user[user] = sd
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
    for user, data in (user_spend.items() if not _usage_scan_truncated else ()):
        if data["department"] not in over_budget_depts and user not in blocked_by_dept:
            if remove_dept_deny_policy(user):
                dept_released += 1

    # ─── ADR-014: mantle (unmetered) for unlimited users ───
    try:
        mantle = reconcile_mantle(user_budgets, dept_budgets)
    except Exception as e:
        print(f"[MANTLE] reconcile failed: {e}")
        mantle = {"error": str(e)}

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
        "weekly_budget_usd": WEEKLY_BUDGET,
        "monthly_budget_usd": MONTHLY_BUDGET,
        "dept_warnings": len(dept_warnings),
        "dept_over_budget": len(dept_over_budget),
        "dept_denied": dept_denied,
        "dept_released": dept_released,
        "token_backup": token_backup,
        "mantle": mantle,
        "timestamp": datetime.utcnow().isoformat(),
    }
