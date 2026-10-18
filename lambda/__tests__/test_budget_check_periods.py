"""ADR-008 (2026-10-18): per-user USD budgets are three independent caps —
daily / weekly / monthly — and exceeding ANY one blocks. Each cap resolves
user > dept per-user default > global env, independently per period."""
import os
import sys
import importlib
from datetime import datetime
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("COGNITO_USER_POOL_ID", "pool-1")

bc = importlib.import_module("budget-check")

NOW = datetime(2026, 10, 18, 11, 0, 0)  # Sunday; ISO week starts Mon 2026-10-12


def test_period_bounds_utc():
    b = bc.period_bounds(NOW)
    assert b["daily"] == ("2026-10-18", datetime(2026, 10, 19))
    assert b["weekly"] == ("2026-10-12", datetime(2026, 10, 19))
    assert b["monthly"] == ("2026-10-01", datetime(2026, 11, 1))
    dec = bc.period_bounds(datetime(2026, 12, 31, 23, 0))
    assert dec["monthly"][1] == datetime(2027, 1, 1)


def test_limits_resolve_per_period_user_then_dept_then_env():
    users = {"a@x.com": {"dailyBudget": 50, "weeklyBudget": 0, "monthlyBudget": 200}}
    depts = {"eng": {"perUserWeeklyBudget": 100, "perUserDailyBudget": 30}}
    lim = bc._effective_user_limits(users, depts, "a@x.com", "eng")
    assert lim == {"daily": 50, "weekly": 100, "monthly": 200}
    # no user row, no dept → global env (daily default 50, weekly/monthly 0 = no cap)
    assert bc._effective_user_limits({}, {}, "b@x.com", "none") == {
        "daily": bc.DAILY_BUDGET, "weekly": bc.WEEKLY_BUDGET, "monthly": bc.MONTHLY_BUDGET}


def test_any_period_over_blocks_and_release_waits_for_latest_reset():
    limits = {"daily": 50, "weekly": 100, "monthly": 200}
    # daily fine, weekly blown → blocked until next Monday
    ev = bc.evaluate_user_budget({"daily": 10, "weekly": 100, "monthly": 120}, limits, NOW)
    assert ev["exceeded"] == ["weekly"]
    assert ev["release_at"] == "2026-10-19T00:00:00Z"
    # daily + monthly blown → release waits for month rollover
    ev = bc.evaluate_user_budget({"daily": 60, "weekly": 90, "monthly": 250}, limits, NOW)
    assert ev["exceeded"] == ["daily", "monthly"]
    assert ev["release_at"] == "2026-11-01T00:00:00Z"
    # 80% warning, not blocked
    ev = bc.evaluate_user_budget({"daily": 41, "weekly": 50, "monthly": 60}, limits, NOW)
    assert ev["exceeded"] == [] and ev["warned"] == ["daily"] and ev["release_at"] == ""
    # 0 = no cap for that period
    ev = bc.evaluate_user_budget({"daily": 999, "weekly": 0, "monthly": 0},
                                 {"daily": 0, "weekly": 0, "monthly": 0}, NOW)
    assert ev["exceeded"] == []


def test_period_usage_scan_buckets_claude_and_codex_rows():
    bc._valid_user_keys = set()  # fail-open
    bc._subdomain_by_user = {}
    rows = [
        {"PK": "USER#a@x.com", "SK": "2026-10-18#claude-opus-4-8", "estimatedCost": 5, "department": "eng", "subdomain": "a"},
        {"PK": "USER#a@x.com", "SK": "2026-10-18#gpt-6.1-sol", "estimatedCost": 2, "department": "eng"},
        {"PK": "USER#a@x.com", "SK": "2026-10-13#gpt-6.1-sol", "estimatedCost": 10, "department": "eng"},
        {"PK": "USER#a@x.com", "SK": "2026-10-02#claude-sonnet-5", "estimatedCost": 20, "department": "eng"},
        {"PK": "USER#a@x.com", "SK": "2026-09-30#claude-sonnet-5", "estimatedCost": 99, "department": "eng"},
    ]
    captured = {}

    def scan(**kw):
        captured.update(kw)
        lo = kw["ExpressionAttributeValues"][":from"]
        hi = kw["ExpressionAttributeValues"][":to"]
        return {"Items": [r for r in rows if lo <= r["SK"] <= hi]}

    with mock.patch.object(bc.table, "scan", side_effect=scan):
        out = bc.get_user_period_usage(NOW)
    a = out["a@x.com"]
    assert a["daily"] == 7 and a["weekly"] == 17 and a["monthly"] == 37
    # scan window starts at the earlier of week/month start; OTEL rows (PROD#…) sort above :to
    assert captured["ExpressionAttributeValues"][":from"] == "2026-10-01"
    assert "PROD#2026-10-18" > captured["ExpressionAttributeValues"][":to"]
    assert bc._subdomain_by_user["a@x.com"] == "a"


def test_department_taken_from_most_recent_row():
    bc._valid_user_keys = set()  # fail-open
    bc._subdomain_by_user = {}
    rows = [
        # older row listed FIRST — scan order must not decide the department
        {"PK": "USER#d@x.com", "SK": "2026-10-02#claude-sonnet-5", "estimatedCost": 1, "department": "old"},
        {"PK": "USER#d@x.com", "SK": "2026-10-18#claude-opus-4-8", "estimatedCost": 2, "department": "new"},
    ]

    def scan(**kw):
        lo = kw["ExpressionAttributeValues"][":from"]
        hi = kw["ExpressionAttributeValues"][":to"]
        return {"Items": [r for r in rows if lo <= r["SK"] <= hi]}

    with mock.patch.object(bc.table, "scan", side_effect=scan):
        out = bc.get_user_period_usage(NOW)
    assert out["d@x.com"]["department"] == "new"
    assert "_dept_date" not in out["d@x.com"]


def test_handler_blocks_on_weekly_and_releases_others():
    spend = {
        "a@x.com": {"daily": 5.0, "weekly": 120.0, "monthly": 150.0, "cost": 5.0, "department": "eng"},
        "b@x.com": {"daily": 1.0, "weekly": 2.0, "monthly": 3.0, "cost": 1.0, "department": "eng"},
    }
    budgets = {"a@x.com": {"dailyBudget": 50, "weeklyBudget": 100, "monthlyBudget": 200}}
    written = {}
    with mock.patch.object(bc, "_load_valid_user_keys", return_value=set()), \
            mock.patch.object(bc, "get_user_period_usage", return_value=spend), \
            mock.patch.object(bc, "get_user_budgets", return_value=budgets), \
            mock.patch.object(bc, "get_department_budgets", return_value={}), \
            mock.patch.object(bc, "get_monthly_usage_by_department", return_value={}), \
            mock.patch.object(bc, "write_current_spend", side_effect=lambda u, d: written.update(u)), \
            mock.patch.object(bc, "attach_deny_policy", return_value=True) as attach, \
            mock.patch.object(bc, "remove_deny_policy", return_value=False) as remove, \
            mock.patch.object(bc, "set_cognito_budget_flag"), \
            mock.patch.object(bc, "check_department_budgets", return_value=([], [])), \
            mock.patch.object(bc, "remove_dept_deny_policy", return_value=False), \
            mock.patch.object(bc, "check_token_limits_backup", return_value={}), \
            mock.patch.object(bc, "SNS_TOPIC_ARN", ""):
        out = bc.handler({}, None)
    attach.assert_called_once_with("a@x.com")
    assert out["over_budget"] == 1 and out["denied"] == 1
    removed = {c.args[0] for c in remove.call_args_list}
    assert "b@x.com" in removed and "a@x.com" not in removed
    assert written["a@x.com"]["evaluation"]["exceeded"] == ["weekly"]
