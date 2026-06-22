"""T7 (ADR-031 B′): limit-reset detaches the Deny from local-user-{subdomain}
(subdomain from the DENY#active record, NOT the email PK suffix). Legacy non-email
PKs (sub/subdomain) still resolve via the suffix.
"""
import os
import sys
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "lambda"))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("LIMITS_TABLE", "cc-on-bedrock-limits")

lr = importlib.import_module("limit-reset")


def test_role_for_item_uses_subdomain_attr():
    item = {"PK": "USER#alice@example.com", "SK": "DENY#active", "subdomain": "alice"}
    assert lr._role_for_item(item) == "cc-on-bedrock-local-user-alice"


def test_role_for_item_email_pk_without_subdomain_is_none():
    # email PK + no subdomain attr → cannot build a valid role name (never use email)
    item = {"PK": "USER#alice@example.com", "SK": "DENY#active"}
    assert lr._role_for_item(item) is None


def test_role_for_item_legacy_sub_pk_uses_suffix():
    # legacy DENY row keyed by sub/subdomain (no @) → suffix is the identifier
    item = {"PK": "USER#84c82d0c-d091-705d-0021-83c951039b97", "SK": "DENY#active"}
    assert lr._role_for_item(item) == "cc-on-bedrock-local-user-84c82d0c-d091-705d-0021-83c951039b97"


def test_detach_targets_role():
    iam = mock.Mock()
    iam.exceptions.NoSuchEntityException = lr.iam.exceptions.NoSuchEntityException
    captured = {}
    iam.delete_role_policy.side_effect = lambda **kw: captured.update(kw)
    with mock.patch.object(lr, "iam", iam):
        ok = lr._detach("cc-on-bedrock-local-user-alice")
    assert ok == "ok"
    assert captured["RoleName"] == "cc-on-bedrock-local-user-alice"


def test_handler_preserves_deny_row_when_role_unresolved():
    # PR #68 review: an email-keyed DENY#active row with no `subdomain` → role unresolved → the
    # IAM deny can't be detached → the row MUST be preserved (not silently deleted) to avoid a
    # permanent lockout where the deny is orphaned with no tracking record.
    iam = mock.Mock()
    iam.exceptions.NoSuchEntityException = lr.iam.exceptions.NoSuchEntityException
    limits = mock.Mock()
    bad = {"PK": "USER#ghost@example.com", "SK": "DENY#active"}  # no subdomain attr → _role_for_item None
    with mock.patch.object(lr, "iam", iam), \
         mock.patch.object(lr, "limits", limits), \
         mock.patch.object(lr, "_scan_deny_active", lambda period: [bad]), \
         mock.patch.object(lr, "_delete_counters", lambda *a, **k: 0), \
         mock.patch.object(lr, "_scan_warn", lambda period: []), \
         mock.patch.object(lr, "_notify", lambda *a, **k: None):
        lr.handler({"period": "daily"}, None)
    limits.delete_item.assert_not_called()  # row preserved — no silent lockout
    iam.delete_role_policy.assert_not_called()


def test_handler_preserves_deny_row_on_transient_detach_error():
    # Transient IAM error during detach → deny may still be attached → preserve the row for retry.
    iam = mock.Mock()
    iam.exceptions.NoSuchEntityException = lr.iam.exceptions.NoSuchEntityException
    iam.delete_role_policy.side_effect = RuntimeError("throttled")
    limits = mock.Mock()
    item = {"PK": "USER#alice@example.com", "SK": "DENY#active", "subdomain": "alice"}
    with mock.patch.object(lr, "iam", iam), \
         mock.patch.object(lr, "limits", limits), \
         mock.patch.object(lr, "_scan_deny_active", lambda period: [item]), \
         mock.patch.object(lr, "_delete_counters", lambda *a, **k: 0), \
         mock.patch.object(lr, "_scan_warn", lambda period: []), \
         mock.patch.object(lr, "_notify", lambda *a, **k: None):
        lr.handler({"period": "daily"}, None)
    limits.delete_item.assert_not_called()  # preserved for next-run retry
