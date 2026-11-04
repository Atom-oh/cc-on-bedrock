"""Session insights: the tracker's cc.session-report handler re-validates client
buckets, prices each model with the PRICING table and PutItems one overwrite row
per (tool, sessionId, date) into the sessions table. Usage rows are never touched."""
import copy
import json
import os
import sys
import importlib
from datetime import datetime, timezone
from decimal import Decimal
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("USAGE_TABLE_NAME", "cc-on-bedrock-usage")

tracker = importlib.import_module("bedrock-usage-tracker")

NOW = datetime(2026, 11, 4, 3, 0, tzinfo=timezone.utc)


class FakeTable:
    """PutItem overwrites by (PK, SK), like DynamoDB."""

    def __init__(self):
        self.items = {}

    def put_item(self, Item):
        self.items[(Item["PK"], Item["SK"])] = copy.deepcopy(Item)


def bucket(**over):
    b = {
        "tool": "claude", "sessionId": "0a1b2c3d-sess", "date": "2026-11-03",
        "firstAt": "2026-11-03T01:00:00Z", "lastAt": "2026-11-03T02:30:00.123Z",
        "turns": 4,
        "models": {
            "claude-opus-5-5": {"requests": 10, "inputTokens": 1_000_000, "outputTokens": 100_000,
                                "cacheReadTokens": 2_000_000, "cacheWriteTokens": 400_000},
            "claude-haiku-5-5": {"requests": 2, "inputTokens": 1_000_000, "outputTokens": 0,
                                 "cacheReadTokens": 0, "cacheWriteTokens": 0},
        },
    }
    b.update(over)
    return b


def run(event):
    fake, usage = FakeTable(), mock.Mock()
    with mock.patch.object(tracker, "_sessions_table", fake), mock.patch.object(tracker, "table", usage), \
            mock.patch.object(tracker, "datetime", wraps=datetime) as dt:
        dt.now.return_value = NOW
        out = tracker.handler(dict(event, source="cc.session-report"), None)
    assert not usage.method_calls, "session reports must never touch usage rows"
    return out, fake


def event(buckets, email="Alice@Example.com"):
    return {"email": email, "department": "eng", "subdomain": "alice", "buckets": buckets}


def test_row_shape_and_cost():
    out, fake = run(event([bucket()]))
    assert out == {"accepted": 1, "rejected": 0}
    (key, row), = fake.items.items()
    assert key == ("USER#alice@example.com", "SESSION#claude#0a1b2c3d-sess#2026-11-03")
    assert row["email"] == "alice@example.com" and row["department"] == "eng"
    assert row["subdomain"] == "alice" and row["tool"] == "claude"
    assert row["gsiDate"] == row["date"] == "2026-11-03"
    assert row["turns"] == 4 and row["requests"] == 12
    assert row["inputTokens"] == 2_000_000 and row["outputTokens"] == 100_000
    assert row["cacheReadTokens"] == 2_000_000 and row["cacheWriteTokens"] == 400_000
    # opus-5-5: 4.0 + 2.0 + 0.4 + 2.0 = 8.4; haiku-5-5: 0.1
    assert isinstance(row["estimatedCost"], Decimal)
    assert abs(float(row["estimatedCost"]) - 8.5) < 1e-9
    models = json.loads(row["models"])
    assert abs(models["claude-opus-5-5"]["estimatedCost"] - 8.4) < 1e-9
    assert models["claude-haiku-5-5"]["requests"] == 2
    assert row["ttl"] == int(NOW.timestamp()) + 180 * 86400
    assert row["updatedAt"].startswith("2026-11-04T03:00")


def test_codex_model_ids_priced_as_gpt_6_1_sol():
    b = bucket(tool="codex", models={
        "gpt-6.1-sol": {"requests": 1, "inputTokens": 1_000_000, "outputTokens": 0},
        "openai.gpt-6.1-sol": {"requests": 1, "inputTokens": 0, "outputTokens": 1_000_000}})
    out, fake = run(event([b]))
    row = next(iter(fake.items.values()))
    assert out["accepted"] == 1 and row["SK"].startswith("SESSION#codex#")
    assert abs(float(row["estimatedCost"]) - 12.0) < 1e-9  # $2 in + $10 out


def test_resend_overwrites_not_adds():
    fake = FakeTable()
    with mock.patch.object(tracker, "_sessions_table", fake):
        tracker.process_session_report(event([bucket(turns=2)]), now=NOW)
        tracker.process_session_report(event([bucket(turns=5)]), now=NOW)
    assert len(fake.items) == 1
    assert next(iter(fake.items.values()))["turns"] == 5


def test_invalid_buckets_dropped():
    bad = [
        bucket(tool="kiro"),
        bucket(sessionId="has space"),
        bucket(sessionId="x" * 129),
        bucket(date="2026-09-01"),           # older than 35 days
        bucket(date="2026-11-06"),           # more than +1 day in the future
        bucket(date="2026-02-30"),
        bucket(turns=-1),
        bucket(turns=True),
        bucket(firstAt="yesterday"),
        bucket(models={}),
        bucket(models={f"m{i}": {"requests": 1} for i in range(21)}),
        bucket(models={"claude-opus-5-5": {"requests": 1.5}}),
        "not a dict",
    ]
    out, fake = run(event(bad + [bucket(date="2026-11-05")]))
    assert out == {"accepted": 1, "rejected": len(bad)}
    assert len(fake.items) == 1


def test_request_level_rejections():
    out, fake = run(event([bucket()], email="nobody"))
    assert out["accepted"] == 0 and out["error"] == "invalid email" and not fake.items
    out, fake = run(event([bucket()] * 101))
    assert out["accepted"] == 0 and out["error"] == "invalid buckets" and not fake.items


def test_disabled_when_table_name_empty():
    fake = FakeTable()
    with mock.patch.object(tracker, "SESSIONS_TABLE_NAME", ""), mock.patch.object(tracker, "_sessions_table", fake):
        out = tracker.process_session_report(event([bucket()]), now=NOW)
    assert out["accepted"] == 0 and out["error"] == "session insights disabled" and not fake.items
