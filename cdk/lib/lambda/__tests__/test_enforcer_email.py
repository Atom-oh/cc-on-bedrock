"""T3 (ADR-031 B′): enforcer keys limits/counters by USER#{email} and builds the
Local Governance role name from the row's `subdomain` attribute — never from the
email PK suffix. Deny attach verifies the role's email owner-tag and fail-safe
skips when subdomain is missing.
"""
import os
import sys
import importlib
from decimal import Decimal
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("LIMITS_TABLE", "cc-on-bedrock-limits")

enf = importlib.import_module("token-limit-enforcer")


def _rec(pk, sk, subdomain, in_new, out_new, dept="eng"):
    img = {
        "PK": {"S": pk}, "SK": {"S": sk},
        "model": {"S": "claude-opus-4-8"},
        "department": {"S": dept},
        "inputTokens": {"N": str(in_new)}, "outputTokens": {"N": str(out_new)},
    }
    if subdomain is not None:
        img["subdomain"] = {"S": subdomain}
    return {"eventName": "INSERT", "dynamodb": {"NewImage": img}}


def test_attach_deny_builds_role_from_subdomain_not_email():
    calls = {}
    iam = mock.Mock()
    iam.get_role.return_value = {"Role": {"Tags": [{"Key": "email", "Value": "alice@example.com"}]}}
    iam.exceptions.NoSuchEntityException = enf.iam.exceptions.NoSuchEntityException

    def put_role_policy(**kw):
        calls["role"] = kw["RoleName"]
    iam.put_role_policy.side_effect = put_role_policy

    with mock.patch.object(enf, "iam", iam), \
         mock.patch.object(enf.limits, "put_item"), \
         mock.patch.object(enf, "_publish_sns"):
        ok = enf._attach_deny("alice@example.com", "alice", "user daily limit", "daily", "2026-06-13T00:00:00Z")

    assert ok is True
    # role name uses the subdomain, NOT the email PK suffix
    assert calls["role"] == "cc-on-bedrock-local-user-alice"
    assert "@" not in calls["role"]


def test_attach_deny_skips_when_subdomain_missing():
    iam = mock.Mock()
    iam.exceptions.NoSuchEntityException = enf.iam.exceptions.NoSuchEntityException
    with mock.patch.object(enf, "iam", iam), \
         mock.patch.object(enf.limits, "put_item"):
        ok = enf._attach_deny("alice@example.com", None, "reason", "daily", "x")
    assert ok is False
    iam.put_role_policy.assert_not_called()  # fail-safe: no bad role


def test_attach_deny_owner_tag_mismatch_blocks_attach():
    # subdomain collision defense: role owned by a different email → do not attach
    iam = mock.Mock()
    iam.get_role.return_value = {"Role": {"Tags": [{"Key": "email", "Value": "other@example.com"}]}}
    iam.exceptions.NoSuchEntityException = enf.iam.exceptions.NoSuchEntityException
    with mock.patch.object(enf, "iam", iam), \
         mock.patch.object(enf.limits, "put_item"):
        ok = enf._attach_deny("alice@example.com", "alice", "reason", "daily", "x")
    assert ok is False
    iam.put_role_policy.assert_not_called()


def test_process_record_passes_subdomain_to_attach():
    captured = {}

    def fake_attach(user_key, subdomain, reason, period, reset_at):
        captured["user_key"] = user_key
        captured["subdomain"] = subdomain
        return True

    with mock.patch.object(enf, "_add_counter", return_value=Decimal("999999")), \
         mock.patch.object(enf, "_get_user_limit", return_value={"max_normalized": Decimal("1")}), \
         mock.patch.object(enf, "_get_dept_limit", return_value={}), \
         mock.patch.object(enf, "_attach_deny", side_effect=fake_attach):
        enf.process_record(_rec("USER#alice@example.com", "2026-06-12#claude-opus-4-8", "alice", 100, 100))

    assert captured["user_key"] == "alice@example.com"
    assert captured["subdomain"] == "alice"
