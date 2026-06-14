"""T4 (ADR-031 B′): budget-check enforces by email-keyed rows and builds BOTH IAM
role names from the row's subdomain (local-user-{subdomain} + task-{subdomain}),
never local-user-{email}. Cognito budget flag filters by email. Valid-key set and
comparisons are lowercased.
"""
import os
import sys
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("COGNITO_USER_POOL_ID", "pool-1")

bc = importlib.import_module("budget-check")


def test_candidate_role_names_from_subdomain_not_email():
    bc._subdomain_by_user = {"alice@example.com": "alice"}
    names = bc._candidate_role_names("alice@example.com")
    assert "cc-on-bedrock-local-user-alice" in names
    assert "cc-on-bedrock-task-alice" in names
    # never build a role name from the email
    assert all("@" not in n for n in names)


def test_candidate_role_names_no_subdomain_yields_nothing_unsafe():
    bc._subdomain_by_user = {}
    names = bc._candidate_role_names("ghost@example.com")
    # fail-safe: with no subdomain we must NOT emit local-user-{email}
    assert all("@" not in n for n in names)


def test_set_cognito_budget_flag_uses_email_filter():
    captured = {}
    cog = mock.Mock()

    def list_users(**kw):
        captured["Filter"] = kw.get("Filter", "")
        return {"Users": [{"Username": "alice"}]}
    cog.list_users.side_effect = list_users
    with mock.patch.object(bc, "cognito_client", cog):
        bc.set_cognito_budget_flag("alice@example.com", True)
    assert 'email = "alice@example.com"' in captured["Filter"]
    assert "sub =" not in captured["Filter"]


def test_is_valid_user_lowercase():
    bc._valid_user_keys = {"alice@example.com"}
    assert bc._is_valid_user("Alice@Example.com")  # mixed case still matches
    assert not bc._is_valid_user("bob@example.com")


def test_resolve_subdomain_via_cognito_reads_custom_attr():
    # Deny-deadlock fix: release path resolves a denied/idle user's subdomain from Cognito
    # (email filter → custom:subdomain), since usage scans never captured it.
    captured = {}
    cog = mock.Mock()

    def list_users(**kw):
        captured["Filter"] = kw.get("Filter", "")
        return {"Users": [{"Username": "u1", "Attributes": [
            {"Name": "email", "Value": "john@example.com"},
            {"Name": "custom:subdomain", "Value": "john-doe-2"},
        ]}]}
    cog.list_users.side_effect = list_users
    with mock.patch.object(bc, "cognito_client", cog):
        sd = bc._resolve_subdomain_via_cognito("John@Example.com")
    assert sd == "john-doe-2"  # collision-disambiguated subdomain, not derivable from email
    assert 'email = "john@example.com"' in captured["Filter"]
    # non-email / miss → None (fail-safe, no bad role)
    with mock.patch.object(bc, "cognito_client", cog):
        assert bc._resolve_subdomain_via_cognito("not-an-email") is None


def test_is_valid_user_failopen_when_empty():
    bc._valid_user_keys = set()
    assert bc._is_valid_user("anything")  # fail-open
