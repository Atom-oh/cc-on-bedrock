"""T4 (ADR-031 B′): budget-check enforces by email-keyed rows and builds BOTH IAM
role names from the row's subdomain (local-user-{subdomain} + task-{subdomain}),
never local-user-{email}. Cognito budget flag filters by email. Valid-key set and
comparisons are lowercased.
"""
import os
import sys
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "lambda"))
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


def test_load_valid_user_keys_builds_email_subdomain_map_one_scan():
    # Deny-deadlock fix (no N+1): the release path's email→subdomain map is built from the SAME
    # single paginated Cognito scan as the valid-key set — not a per-user ListUsers.
    calls = {"n": 0}
    cog = mock.Mock()

    def list_users(**kw):
        calls["n"] += 1  # must be ONE call (no pagination here, no per-user lookups)
        return {"Users": [
            {"Username": "u1", "Attributes": [
                {"Name": "email", "Value": "John@Example.com"},
                {"Name": "custom:subdomain", "Value": "john-doe-2"}]},
            {"Username": "u2", "Attributes": [
                {"Name": "email", "Value": "amy@example.com"},
                {"Name": "custom:subdomain", "Value": "amy"}]},
        ]}
    cog.list_users.side_effect = list_users
    with mock.patch.object(bc, "cognito_client", cog):
        keys = bc._load_valid_user_keys()
    assert calls["n"] == 1
    # collision-disambiguated subdomain captured, email lowercased
    assert bc._email_subdomain_map["john@example.com"] == "john-doe-2"
    assert bc._email_subdomain_map["amy@example.com"] == "amy"
    assert "john@example.com" in keys


def test_is_valid_user_failopen_when_empty():
    bc._valid_user_keys = set()
    assert bc._is_valid_user("anything")  # fail-open
