"""T8 (ADR-029 B′): backfill identity maps, re-key planning, counter merge,
subdomain-collision abort.
"""
import os
import sys
import importlib
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
mig = importlib.import_module("migrate_usage_to_email")


def _user(sub, email, sd=None):
    attrs = [{"Name": "sub", "Value": sub}, {"Name": "email", "Value": email}]
    if sd:
        attrs.append({"Name": "custom:subdomain", "Value": sd})
    return {"Attributes": attrs}


def test_identity_maps_basic():
    maps = mig.build_identity_maps([
        _user("84c82d0c-sub", "psungbum@example.com", "psungbum"),
    ])
    assert maps["sub2email"]["84c82d0c-sub"] == "psungbum@example.com"
    assert maps["sd2email"]["psungbum"] == "psungbum@example.com"
    assert maps["sub2sd"]["84c82d0c-sub"] == "psungbum"
    assert maps["collisions"] == {}


def test_identity_maps_lowercases_email():
    maps = mig.build_identity_maps([_user("s1", "Alice@Example.COM", "alice")])
    assert maps["sub2email"]["s1"] == "alice@example.com"


def test_subdomain_collision_aborts_mapping():
    maps = mig.build_identity_maps([
        _user("s1", "john.doe@a.com", "john-doe"),
        _user("s2", "john_doe@b.com", "john-doe"),
    ])
    # colliding subdomain is excluded from sd2email and reported
    assert "john-doe" in maps["collisions"]
    assert "john-doe" not in maps["sd2email"]


def test_target_email_from_sub_and_subdomain():
    maps = mig.build_identity_maps([_user("84c82d0c-sub", "psungbum@example.com", "psungbum")])
    assert mig.target_email("84c82d0c-sub", maps) == ("psungbum@example.com", "psungbum")
    assert mig.target_email("psungbum", maps) == ("psungbum@example.com", "psungbum")
    # already-email PK → skip
    assert mig.target_email("psungbum@example.com", maps) == (None, None)
    # unknown → skip
    assert mig.target_email("ghost", maps) == (None, None)


def test_plan_row_rekeys_usage_to_email():
    maps = mig.build_identity_maps([_user("84c82d0c-sub", "psungbum@example.com", "psungbum")])
    item = {"PK": "USER#84c82d0c-sub", "SK": "2026-06-12#claude-opus-4-8",
            "inputTokens": Decimal("100"), "subdomain": "psungbum"}
    new_item, old_key, is_limit = mig.plan_row(item, maps)
    assert new_item["PK"] == "USER#psungbum@example.com"
    assert new_item["subdomain"] == "psungbum"
    assert old_key == {"PK": "USER#84c82d0c-sub", "SK": "2026-06-12#claude-opus-4-8"}
    assert is_limit is False


def test_plan_row_limit_record_gets_transition_sub():
    maps = mig.build_identity_maps([_user("84c82d0c-sub", "psungbum@example.com", "psungbum")])
    item = {"PK": "USER#84c82d0c-sub", "SK": "LIMIT#monthly", "max_normalized": Decimal("5")}
    new_item, _old, is_limit = mig.plan_row(item, maps)
    assert is_limit is True
    assert new_item["PK"] == "USER#psungbum@example.com"
    assert new_item["sub"] == "84c82d0c-sub"  # transition sub for dual-name


def test_merge_counters_sums():
    existing = {"inputTokens": Decimal("100"), "requests": Decimal("2")}
    incoming = {"inputTokens": Decimal("50"), "requests": Decimal("1"), "PK": "x"}
    out = mig.merge_counters(existing, incoming)
    assert out["inputTokens"] == Decimal("150")
    assert out["requests"] == Decimal("3")
    assert out["PK"] == "x"
