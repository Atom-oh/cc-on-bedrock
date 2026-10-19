"""ADR-014: Codex (OpenAI GPT) usage counts against normalized-token limits with
its own price-proportional weight — never silently as the Sonnet default."""
import os
import sys
import importlib
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("LIMITS_TABLE", "cc-on-bedrock-limits")

enf = importlib.import_module("token-limit-enforcer")


def test_gpt_tiers_resolve_to_their_family():
    assert enf._model_family("gpt-6.1-sol") == "sol"
    assert enf._model_family("gpt-6-astra") == "astra"
    assert enf._model_family("gpt-5.6-luna") == "luna"
    assert enf._model_family("gpt-5.6-terra") == "terra"
    assert enf._model_family("gpt-5.5") == "gpt"
    # Claude families unchanged
    assert enf._model_family("claude-opus-4-8") == "opus"
    assert enf._model_family("claude-haiku-4-5") == "haiku"


def _tracker():
    import types, importlib.util
    from unittest import mock as _m
    spec = importlib.util.spec_from_file_location(
        "tracker_for_weights", os.path.join(os.path.dirname(__file__), "..", "bedrock-usage-tracker.py"))
    t = importlib.util.module_from_spec(spec)
    with _m.patch("boto3.resource"), _m.patch("boto3.client"):
        spec.loader.exec_module(t)
    return t


def test_all_weights_derive_from_tracker_prices():
    # Weights = list price / $15 so the admin USD→token mirror (NORMALIZED_PER_USD=66667)
    # agrees with the USD budget — compared against the tracker itself, not a copy.
    t = _tracker()
    for model, p in t.PRICING.items():
        if model == "default":
            continue
        assert enf.MODEL_WEIGHTS[model] == {"in": round(p["input"] / 15, 4), "out": round(p["output"] / 15, 4)}, model
    for fam in enf._FAMILY_ORDER:
        p = t.FAMILY_PRICING[fam]
        assert enf.DEFAULT_WEIGHTS[fam] == {"in": round(p["input"] / 15, 4), "out": round(p["output"] / 15, 4)}, fam


def test_usd_mirror_matches_usd_cost():
    # $200 of Opus 4.8 output at $25/1M = 8M tokens; mirror = 200 * 66667 ≈ 13.33M units.
    units = enf._normalize("claude-opus-4-8", 0, 8_000_000)
    assert abs(float(units) - 200 * 66667) / (200 * 66667) < 0.001


def test_codex_normalized_tokens_price_proportional():
    # gpt-6.1-sol: $2/$10 per 1M → 2/15, 10/15 normalized units per token
    n = enf._normalize("gpt-6.1-sol", 1_000_000, 1_000_000)
    assert n == Decimal(str(round(1_000_000 * 0.1333 + 1_000_000 * 0.6667, 4)))
    # A luna call is far cheaper than an astra call of the same size.
    assert enf._normalize("gpt-6-luna", 1000, 1000) < enf._normalize("gpt-6-astra", 1000, 1000)


def test_gpt_5_6_sol_uses_exact_weight_not_family():
    # gpt-5.6-sol is $4/$20 (tracker PRICING) — family is "sol", but the exact
    # per-model weight (0.2667) wins over the family's 0.1333.
    assert enf._model_family("gpt-5.6-sol") == "sol"
    assert enf._normalize("gpt-5.6-sol", 1_000_000, 0) == Decimal(str(round(1_000_000 * 0.2667, 4)))


def test_luna_and_gpt_5_4_exact_weights():
    assert enf._normalize("gpt-6-luna", 1_000_000, 1_000_000) == Decimal(
        str(round(1_000_000 * 0.0067 + 1_000_000 * 0.0333, 4))
    )
    assert enf._normalize("gpt-5.4", 1_000_000, 1_000_000) == Decimal(
        str(round(1_000_000 * 0.1667 + 1_000_000 * 1.0, 4))
    )
