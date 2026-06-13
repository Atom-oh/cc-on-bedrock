"""T4b (ADR-029 B′): provisioner assigns a globally-unique subdomain (no duplicate
names) — colliding email local-parts get a numeric suffix, and the Local role is
named by subdomain.
"""
import os
import sys
import importlib
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("USER_POOL_ID", "pool-1")
os.environ.setdefault("ACCOUNT_ID", "123456789012")
os.environ.setdefault("ASSUMER_ROLE_ARN", "arn:aws:iam::123456789012:role/assumer")

prov = importlib.import_module("user-role-provisioner")


def test_derive_subdomain_basic():
    assert prov.derive_subdomain("psungbum@example.com") == "psungbum"
    assert prov.derive_subdomain("John.Doe@x.com") == "john-doe"


def test_assign_unique_subdomain_free():
    # base not owned by anyone → returned as-is
    with mock.patch.object(prov, "_subdomain_owner_email", return_value=None):
        assert prov._assign_unique_subdomain("alice", "alice@a.com", "sub-1") == "alice"


def test_assign_unique_subdomain_same_owner_idempotent():
    with mock.patch.object(prov, "_subdomain_owner_email", return_value="alice@a.com"):
        assert prov._assign_unique_subdomain("alice", "Alice@A.com", "sub-1") == "alice"


def test_assign_unique_subdomain_collision_gets_suffix():
    # base owned by a different email → must disambiguate, never share
    owners = {"john-doe": "john_doe@b.com"}  # taken by someone else

    def owner(sd):
        return owners.get(sd)  # None for any free candidate

    with mock.patch.object(prov, "_subdomain_owner_email", side_effect=owner):
        out = prov._assign_unique_subdomain("john-doe", "john.doe@a.com", "sub-2")
    assert out == "john-doe-2"
    assert out != "john-doe"
