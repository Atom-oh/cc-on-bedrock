"""One-time budget grants on the token axis: an approved increase adds
`grant_normalized` (KST month `grant_bucket`) to the user's LIMIT#monthly row, and
the enforcer's user cap includes it only for the monthly period of that month.
"""
import os
import sys
import importlib
from datetime import datetime
from decimal import Decimal
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("LIMITS_TABLE", "cc-on-bedrock-limits")

enf = importlib.import_module("token-limit-enforcer")

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=enf.KST)
ITEM = {"max_normalized": 1000, "grant_bucket": "2026-10", "grant_normalized": 500}


def test_user_cap_includes_current_month_grant():
    assert enf._user_cap(ITEM, "monthly", NOW) == Decimal("1500")


def test_user_cap_ignores_past_month_grant():
    assert enf._user_cap({**ITEM, "grant_bucket": "2026-09"}, "monthly", NOW) == Decimal("1000")


def test_user_cap_ignores_grant_for_other_periods():
    assert enf._user_cap(ITEM, "daily", NOW) == Decimal("1000")
    assert enf._user_cap(ITEM, "weekly", NOW) == Decimal("1000")


def test_user_cap_uses_kst_month():
    # 2026-10-31T16:00Z is already November in KST.
    nov = datetime(2026, 10, 31, 16, 0, tzinfo=enf.timezone.utc).astimezone(enf.KST)
    assert enf._user_cap({**ITEM, "grant_bucket": "2026-11"}, "monthly", nov) == Decimal("1500")


def test_user_cap_without_grant_or_limit():
    assert enf._user_cap({"max_normalized": 1000}, "monthly", NOW) == Decimal("1000")
    assert enf._user_cap({}, "monthly", NOW) == Decimal("0")


def test_user_cap_grant_never_caps_an_uncapped_user():
    assert enf._user_cap({"max_normalized": 0, "grant_bucket": "2026-10", "grant_normalized": 500}, "monthly", NOW) == 0


def _rec(total_in):
    img = {
        "PK": {"S": "USER#dev@x.com"}, "SK": {"S": "2026-10-24#claude-opus-4-8"},
        "model": {"S": "claude-opus-4-8"}, "department": {"S": "eng"}, "subdomain": {"S": "dev"},
        "inputTokens": {"N": str(total_in)}, "outputTokens": {"N": "0"},
    }
    return {"eventName": "INSERT", "dynamodb": {"NewImage": img}}


def _run(total):
    cache = {("USER#dev@x.com", "LIMIT#monthly"): dict(ITEM)}
    with mock.patch.object(enf, "_now_kst", return_value=NOW), \
         mock.patch.object(enf, "_add_counter", return_value=Decimal(total)), \
         mock.patch.object(enf, "_attach_deny") as deny, \
         mock.patch.object(enf, "_maybe_warn"):
        enf.process_record(_rec(10), cache)
    return deny


def test_enforcer_does_not_deny_within_granted_cap():
    assert not _run(1200).called


def test_enforcer_denies_past_granted_cap():
    deny = _run(1500)
    assert deny.called
    assert deny.call_args.args[3] == "monthly"


def test_enforcer_user_cap_deny_has_user_scope():
    kw = _run(1500).call_args.kwargs
    assert kw["scope"] == "user"
    assert kw["dept"] == "eng"


def test_enforcer_dept_cap_deny_has_dept_scope():
    cache = {("DEPT#eng", "LIMIT#daily"): {"max_normalized": 10}}
    with mock.patch.object(enf, "_now_kst", return_value=NOW), \
         mock.patch.object(enf, "_add_counter", return_value=Decimal(50)), \
         mock.patch.object(enf, "_attach_deny") as deny, \
         mock.patch.object(enf, "_maybe_warn"):
        enf.process_record(_rec(10), cache)
    assert deny.call_args.args[3] == "daily"
    assert deny.call_args.kwargs["scope"] == "dept"
    assert deny.call_args.kwargs["dept"] == "eng"


def _attach(kw):
    iam = mock.Mock()
    iam.list_role_tags.return_value = {"Tags": [{"Key": "email", "Value": "dev@x.com"}]}
    iam.exceptions.NoSuchEntityException = enf.iam.exceptions.NoSuchEntityException
    with mock.patch.object(enf, "iam", iam), \
         mock.patch.object(enf.limits, "put_item") as put, \
         mock.patch.object(enf, "_publish_sns"):
        assert enf._attach_deny("dev@x.com", "dev", "r", "monthly", "x", **kw) is True
    return put.call_args.kwargs["Item"]


def test_deny_row_records_scope_period_and_dept():
    item = _attach({"scope": "dept", "dept": "eng"})
    assert item["scope"] == "dept"
    assert item["period"] == "monthly"
    assert item["dept"] == "eng"
    plain = _attach({"scope": "user"})
    assert plain["scope"] == "user"
    assert "dept" not in plain
