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
