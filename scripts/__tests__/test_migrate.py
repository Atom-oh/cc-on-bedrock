"""T8 (ADR-031 B′): backfill identity maps, re-key planning, counter merge,
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


class _FakeTable:
    """Minimal in-memory DynamoDB table for idempotency tests."""
    def __init__(self, items):
        self.store = {(i["PK"], i["SK"]): dict(i) for i in items}

    def scan(self, **kw):
        return {"Items": [dict(v) for v in self.store.values()]}

    def get_item(self, Key, **kw):  # **kw absorbs ConsistentRead=True (fake is always consistent)
        v = self.store.get((Key["PK"], Key["SK"]))
        return {"Item": dict(v)} if v else {}

    def put_item(self, Item):
        self.store[(Item["PK"], Item["SK"])] = dict(Item)

    def delete_item(self, Key):
        self.store.pop((Key["PK"], Key["SK"]), None)


class _Args:
    apply = True
    delete_old = False


def test_backfill_idempotent_no_double_count():
    maps = mig.build_identity_maps([_user("84c82d0c-sub", "psungbum@example.com", "psungbum")])
    # one usage row keyed by sub
    t = _FakeTable([{"PK": "USER#84c82d0c-sub", "SK": "2026-06-12#m",
                     "inputTokens": Decimal("100"), "requests": Decimal("2")}])
    mig._migrate_table(t, maps, _Args(), "usage")
    after1 = t.store[("USER#psungbum@example.com", "2026-06-12#m")]
    assert after1["inputTokens"] == Decimal("100")
    # source must be gone (summed row deleted same-pass)
    assert ("USER#84c82d0c-sub", "2026-06-12#m") not in t.store
    # re-run must NOT double
    mig._migrate_table(t, maps, _Args(), "usage")
    after2 = t.store[("USER#psungbum@example.com", "2026-06-12#m")]
    assert after2["inputTokens"] == Decimal("100"), f"doubled: {after2['inputTokens']}"


def test_backfill_merges_two_sources_into_one_email():
    # atomoh split: USER#atomoh (subdomain) + USER#b4489d9c (sub) → one email
    maps = mig.build_identity_maps([_user("b4489d9c-sub", "atomoh@example.com", "atomoh")])
    t = _FakeTable([
        {"PK": "USER#atomoh", "SK": "2026-06-10#m", "inputTokens": Decimal("400")},
        {"PK": "USER#b4489d9c-sub", "SK": "2026-06-10#m", "inputTokens": Decimal("300")},
    ])
    mig._migrate_table(t, maps, _Args(), "usage")
    merged = t.store[("USER#atomoh@example.com", "2026-06-10#m")]
    assert merged["inputTokens"] == Decimal("700")  # 400 + 300 sum-preserved


class _FakeBudgetTable:
    def __init__(self, items):
        self.store = {i["user_id"]: dict(i) for i in items}
    def scan(self, **kw):
        return {"Items": [dict(v) for v in self.store.values()]}
    def put_item(self, Item):
        self.store[Item["user_id"]] = dict(Item)
    def delete_item(self, Key):
        self.store.pop(Key["user_id"], None)


def test_budget_rekey_deletes_orphan_uuid_row():
    # the live bug: UUID budget row lingered next to the email row in the UI
    maps = mig.build_identity_maps([_user("84c82d0c-sub", "psungbum@example.com", "psungbum")])
    t = _FakeBudgetTable([{"user_id": "84c82d0c-sub", "monthlyBudget": Decimal("50")}])
    mig._migrate_user_budgets(t, maps, _Args())
    assert "psungbum@example.com" in t.store
    assert "84c82d0c-sub" not in t.store, "stale UUID budget row must be deleted"
    # idempotent re-run: email row stays, no resurrection
    mig._migrate_user_budgets(t, maps, _Args())
    assert list(t.store.keys()) == ["psungbum@example.com"]
