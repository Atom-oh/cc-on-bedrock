"""One-time budget grants: UTC period keys, cascading targets, active grant lookup."""
import os
import sys
import importlib
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("COGNITO_USER_POOL_ID", "pool-1")

bc = importlib.import_module("budget-check")

NOW = datetime(2026, 10, 24, 3, 0)   # Sat, ISO 2026-W43


def test_period_key_utc():
    assert bc.period_key("daily", NOW) == "2026-10-24"
    assert bc.period_key("weekly", NOW) == "2026-W43"
    assert bc.period_key("monthly", NOW) == "2026-10"
    assert bc.period_key("weekly", datetime(2027, 1, 1)) == "2026-W53"   # ISO year


def test_grant_attr():
    assert bc.grant_attr("daily", "2026-10-24") == "grant#daily#2026-10-24"


def test_cascade_daily_weekly_monthly():
    assert bc.cascade_targets("daily", NOW) == [("daily", "2026-10-24"), ("weekly", "2026-W43"), ("monthly", "2026-10")]
    assert bc.cascade_targets("weekly", NOW) == [("weekly", "2026-W43"), ("monthly", "2026-10")]
    assert bc.cascade_targets("monthly", NOW) == [("monthly", "2026-10")]


def test_cascade_week_crossing_month():
    fri = datetime(2026, 10, 30, 12, 0)
    assert bc.cascade_targets("daily", fri) == [("daily", "2026-10-30"), ("weekly", "2026-W44"), ("monthly", "2026-10")]
    row = {"grant#daily#2026-10-30": 20, "grant#weekly#2026-W44": 20, "grant#monthly#2026-10": 20}
    assert bc.active_grants(row, datetime(2026, 11, 1, 1, 0)) == {"daily": 0.0, "weekly": 20.0, "monthly": 0.0}


def test_active_grants_ignores_stale_and_non_grant_attrs():
    row = {"grant#daily#2026-10-23": 5, "grant#daily#2026-10-24": 7, "dailyBudget": 50}
    assert bc.active_grants(row, NOW) == {"daily": 7.0, "weekly": 0.0, "monthly": 0.0}


def test_grant_raises_cap_only_when_capped():
    users = {"a@x.com": {"dailyBudget": 50, "weeklyBudget": 0, "monthlyBudget": 200,
                         "grants": {"daily": 20, "weekly": 20, "monthly": 20}}}
    lim = bc._effective_user_limits(users, {}, "a@x.com", "eng")
    assert lim["daily"] == 70 and lim["monthly"] == 220
    assert lim["weekly"] == bc.WEEKLY_BUDGET + (20 if bc.WEEKLY_BUDGET > 0 else 0)


def test_grant_lifts_block_in_evaluation():
    limits = bc._effective_user_limits({"a@x.com": {"dailyBudget": 50, "grants": {"daily": 20, "weekly": 0, "monthly": 0}}}, {}, "a@x.com", "eng")
    assert bc.evaluate_user_budget({"daily": 60}, limits, NOW)["exceeded"] == []


def test_get_user_budgets_attaches_active_grants(monkeypatch):
    from decimal import Decimal
    row = {"user_id": "a@x.com", "dailyBudget": Decimal("50"),
           "grant#daily#2000-01-01": Decimal("99"),   # stale window, ignored
           f"grant#daily#{bc.period_key('daily')}": Decimal("20")}

    class FakeTable:
        def scan(self, **kw):
            return {"Items": [row]}

    monkeypatch.setattr(bc, "user_budgets_table", FakeTable())
    got = bc.get_user_budgets()["a@x.com"]
    assert got["grants"] == {"daily": 20.0, "weekly": 0.0, "monthly": 0.0}


def test_write_current_spend_records_active_grants(monkeypatch):
    calls = []

    class FakeTable:
        def update_item(self, **kw):
            calls.append(kw)

    monkeypatch.setattr(bc, "user_budgets_table", FakeTable())
    bc.write_current_spend({"a@x.com": {"cost": 1.0, "department": "eng",
                                         "grants": {"daily": 20.0, "weekly": 0.0, "monthly": 5.0}}}, {})
    vals = calls[0]["ExpressionAttributeValues"]
    assert (vals[":gd"], vals[":gw"], vals[":gm"]) == (20, 0, 5)
    assert "activeGrantDaily = :gd" in calls[0]["UpdateExpression"]
