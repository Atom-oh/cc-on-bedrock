"""T2/T4b (ADR-029 B′): role_factory names the Local Governance role by subdomain
(cc-on-bedrock-local-user-{subdomain}), tags it with email + subdomain, and guards
against subdomain collisions (a role already owned by a different email → raise).
"""
import os
import sys
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("ACCOUNT_ID", "123456789012")
os.environ.setdefault("ASSUMER_ROLE_ARN", "arn:aws:iam::123456789012:role/assumer")

rf = importlib.import_module("role_factory")


def test_role_name_uses_subdomain():
    assert rf.role_name("alice") == "cc-on-bedrock-local-user-alice"
    assert "@" not in rf.role_name("alice")


def _no_such_entity():
    class _E(Exception):
        pass
    return _E


def test_ensure_role_creates_with_subdomain_and_email_tag():
    captured = {}
    iam = mock.Mock()
    iam.exceptions.NoSuchEntityException = rf.iam.exceptions.NoSuchEntityException

    def get_role(RoleName):
        raise rf.iam.exceptions.NoSuchEntityException({"Error": {"Code": "NoSuchEntity"}}, "GetRole")
    iam.get_role.side_effect = get_role

    def create_role(**kw):
        captured["name"] = kw["RoleName"]
        captured["tags"] = {t["Key"]: t["Value"] for t in kw["Tags"]}
    iam.create_role.side_effect = create_role

    with mock.patch.object(rf, "iam", iam):
        res = rf.ensure_role("alice", "alice@example.com", "eng", "proj")

    assert captured["name"] == "cc-on-bedrock-local-user-alice"
    assert captured["tags"]["email"] == "alice@example.com"
    assert captured["tags"]["subdomain"] == "alice"
    assert res["created"] is True


def test_ensure_role_collision_raises():
    iam = mock.Mock()
    iam.exceptions.NoSuchEntityException = rf.iam.exceptions.NoSuchEntityException
    # role already exists, owned by a DIFFERENT email
    iam.get_role.return_value = {"Role": {}}
    iam.list_role_tags.return_value = {"Tags": [{"Key": "email", "Value": "other@example.com"}]}

    with mock.patch.object(rf, "iam", iam):
        try:
            rf.ensure_role("alice", "alice@example.com", "eng", "proj")
            assert False, "expected collision RuntimeError"
        except RuntimeError as e:
            assert "collision" in str(e).lower()
    iam.create_role.assert_not_called()


def test_ensure_role_same_owner_refreshes():
    iam = mock.Mock()
    iam.exceptions.NoSuchEntityException = rf.iam.exceptions.NoSuchEntityException
    iam.get_role.return_value = {"Role": {}}
    iam.list_role_tags.return_value = {"Tags": [{"Key": "email", "Value": "alice@example.com"}]}
    with mock.patch.object(rf, "iam", iam):
        res = rf.ensure_role("alice", "Alice@Example.com", "eng", "proj")  # case-insensitive
    assert res["created"] is False
    iam.create_role.assert_not_called()
    iam.tag_role.assert_called()
