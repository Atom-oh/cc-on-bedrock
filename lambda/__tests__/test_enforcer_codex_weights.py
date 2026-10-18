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


def test_claude_weights_not_rescaled():
    # Existing admin quotas are expressed in these units — must stay stable.
    assert enf.DEFAULT_WEIGHTS["opus"] == {"in": 1.0, "out": 5.0}
    assert enf.DEFAULT_WEIGHTS["sonnet"] == {"in": 0.2, "out": 1.0}


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


# Local copy of tracker list prices (USD per 1M tokens: input, output).
_TRACKER_PRICES = {
    "gpt-6.1-sol": (2, 10),
    "gpt-6-astra": (10, 50),
    "gpt-6-sol": (2, 10),
    "gpt-6-luna": (0.10, 0.50),
    "gpt-5.6-sol": (4, 20),
    "gpt-5.6-terra": (2, 12),
    "gpt-5.6-luna": (0.20, 1.20),
    "gpt-5.5": (5, 30),
    "gpt-5.4": (2.5, 15),
}


def test_model_weights_match_tracker_prices():
    assert set(enf.MODEL_WEIGHTS) == set(_TRACKER_PRICES)
    for model, w in enf.MODEL_WEIGHTS.items():
        p_in, p_out = _TRACKER_PRICES[model]
        assert w["in"] == round(p_in / 15, 4), model
        assert w["out"] == round(p_out / 15, 4), model


def test_luna_and_gpt_5_4_exact_weights():
    assert enf._normalize("gpt-6-luna", 1_000_000, 1_000_000) == Decimal(
        str(round(1_000_000 * 0.0067 + 1_000_000 * 0.0333, 4))
    )
    assert enf._normalize("gpt-5.4", 1_000_000, 1_000_000) == Decimal(
        str(round(1_000_000 * 0.1667 + 1_000_000 * 1.0, 4))
    )
