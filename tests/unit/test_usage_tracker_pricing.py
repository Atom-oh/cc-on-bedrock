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


def test_claude_pricing_unchanged():
    m = _load()
    assert m.get_model_pricing("global.anthropic.claude-opus-4-8")["output"] == 75.0
    assert m.get_model_pricing("claude-sonnet-4-6")["output"] == 15.0
    assert m.get_model_pricing("global.anthropic.claude-sonnet-5")["output"] == 15.0
