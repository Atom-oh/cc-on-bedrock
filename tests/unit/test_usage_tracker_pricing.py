"""Pricing must recognize Bedrock embedding models (input-only, no output tokens)
instead of silently falling back to the Sonnet-level default ($3/$15)."""
import importlib.util
import os
import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LAMBDA = REPO / "lambda/bedrock-usage-tracker.py"


def _load():
    from unittest.mock import MagicMock
    # Always install our own MagicMock boto3/botocore (overwrite any weaker stub a
    # sibling unit test left in sys.modules) — this module creates clients at import.
    b = types.ModuleType("boto3")
    b.client = lambda *a, **k: MagicMock()
    b.resource = lambda *a, **k: MagicMock()
    sys.modules["boto3"] = b
    sys.modules.setdefault("botocore", types.ModuleType("botocore"))
    be = types.ModuleType("botocore.exceptions")
    be.ClientError = type("ClientError", (Exception,), {})
    sys.modules["botocore.exceptions"] = be
    os.environ.setdefault("AWS_REGION", "ap-northeast-2")
    spec = importlib.util.spec_from_file_location("bedrock_usage_tracker", LAMBDA)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_embedding_models_priced_input_only_not_sonnet_default():
    m = _load()
    default = m.PRICING["default"]
    for mid in [
        "amazon.titan-embed-text-v2:0",
        "cohere.embed-english-v3",
        "amazon.titan-embed-image-v1",
        "us.amazon.titan-embed-text-v2:0",  # region-prefixed
    ]:
        p = m.get_model_pricing(mid)
        assert p != default, f"{mid} is priced as the Sonnet default — should be an embedding rate"
        assert p["output"] == 0.0, f"{mid} embeddings produce no output tokens"
        assert p["input"] > 0.0, f"{mid} should have a positive input rate"


def test_claude_pricing_matches_bedrock_price_list():
    # AWS Price List API, ap-northeast-2, *_global_standard usage types (2026-10-18).
    m = _load()
    assert m.get_model_pricing("global.anthropic.claude-opus-4-8") == {
        "input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25}
    assert m.get_model_pricing("global.anthropic.claude-sonnet-5")["output"] == 10.0
    assert m.get_model_pricing("claude-sonnet-4-6")["output"] == 15.0
    assert m.get_model_pricing("global.anthropic.claude-haiku-4-5-20251001-v1:0")["input"] == 1.0
    # Longest key wins: opus-5-5 must not be priced as opus-5.
    assert m.get_model_pricing("claude-opus-5-5")["input"] == 4.0
    assert m.get_model_pricing("claude-opus-5")["input"] == 5.0


def test_openai_gpt_models_priced_not_sonnet_default():
    # Codex on Bedrock (ADR-014): Global CRIS short-context rates from the model cards.
    m = _load()
    arn = "arn:aws:bedrock:ap-northeast-2:111122223333:inference-profile/global.openai.gpt-6.1-sol"
    assert m.normalize_model(arn) == "gpt-6.1-sol"
    assert m.get_model_pricing(m.normalize_model(arn)) == {
        "input": 2.0, "output": 10.0, "cache_read": 0.10, "cache_write": 2.5}
    # gpt-6.1-sol must not collide with gpt-6-sol (cache read differs: 0.10 vs 0.20)
    assert m.get_model_pricing("gpt-6-sol")["cache_read"] == 0.20
    assert m.get_model_pricing("global.openai.gpt-6-luna")["output"] == 0.50
    assert m.get_model_pricing("us.openai.gpt-5.6-terra")["output"] == 12.0
    # Unknown future GPT tier falls back to a GPT family rate, never the Sonnet default.
    assert m.get_model_pricing("gpt-7-luna") == m.FAMILY_PRICING["luna"]
    assert m.get_model_pricing("gpt-7") == m.FAMILY_PRICING["gpt"]


def test_estimate_cost_uses_per_model_cache_rates():
    m = _load()
    # GPT-6.1 Sol cache read is 0.05x input ($0.10), not the Anthropic 0.1x ($0.20).
    cost = m.estimate_cost("gpt-6.1-sol", 0, 0, cache_read_tokens=1_000_000)
    assert abs(cost - 0.10) < 1e-9
    # Real invocation-log sample (Codex, gpt-5.5): 11,799 in / 6 out.
    cost = m.estimate_cost("gpt-5.5", 11_799, 6)
    assert abs(cost - (11_799 * 5.0 + 6 * 30.0) / 1e6) < 1e-12
    # Entry without explicit cache rates still uses the multipliers.
    assert abs(m.estimate_cost("default", 0, 0, cache_read_tokens=1_000_000) - 0.3) < 1e-9


def test_tool_attribution_by_vendor():
    m = _load()
    assert m.tool_for_model("claude-opus-4-8") == "claude-code"
    assert m.tool_for_model("gpt-6.1-sol") == "codex"
    assert m.tool_for_model("titan-embed-text-v2") == "other"


def test_unknown_sol_tier_matches_enforcer_sol_weight():
    m = _load()
    assert m.get_model_pricing("gpt-7-sol") == m.FAMILY_PRICING["sol"]
    assert m.FAMILY_PRICING["sol"]["input"] == 2.0 and m.FAMILY_PRICING["sol"]["output"] == 10.0
