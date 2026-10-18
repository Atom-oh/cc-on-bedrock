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
    assert n == Decimal(str(round(1_000_000 * 0.133 + 1_000_000 * 0.667, 4)))
    # A luna call is far cheaper than an astra call of the same size.
    assert enf._normalize("gpt-6-luna", 1000, 1000) < enf._normalize("gpt-6-astra", 1000, 1000)


def test_gpt_5_6_sol_weighted_at_its_price_not_newer_sol():
    # gpt-5.6-sol is $4/$20 (tracker PRICING) — must not inherit the $2/$10 Sol weight.
    assert enf._model_family("gpt-5.6-sol") == "5.6-sol"
    assert enf._model_family("gpt-7-sol") == "sol"
