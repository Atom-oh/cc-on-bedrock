"""Session insights Lambda: aggregation, pseudonymization (no email reaches Bedrock),
strict-JSON parse with fallback, idempotency/force, previous-UTC-date default."""
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

si = importlib.import_module("session-insights")

NOW = datetime(2026, 11, 4, 0, 0, 5, tzinfo=timezone.utc)
DATE = "2026-11-03"


def srow(email, tool, sid, date, turns, cost, models=None, inp=100, cr=800, cw=100, req=None):
    return {"PK": f"USER#{email}", "SK": f"SESSION#{tool}#{sid}#{date}", "email": email,
            "department": "eng", "tool": tool, "sessionId": sid, "date": date, "gsiDate": date,
            "turns": Decimal(turns), "requests": Decimal(req if req is not None else turns * 3),
            "inputTokens": Decimal(inp), "outputTokens": Decimal(50),
            "cacheReadTokens": Decimal(cr), "cacheWriteTokens": Decimal(cw),
            "estimatedCost": Decimal(str(cost)),
            "models": json.dumps(models or {"claude-opus-5-5": {"requests": turns * 3, "estimatedCost": cost}})}


ROWS = [
    srow("alice@example.com", "claude", "a1", DATE, 10, 5.0),
    srow("alice@example.com", "codex", "a2", DATE, 2, 1.0,
         models={"gpt-6.1-sol": {"requests": 6, "estimatedCost": 1.0}}),
    srow("bob@example.com", "claude", "b1", DATE, 4, 2.0, cr=0, inp=900),
    # baseline (7 days before)
    srow("alice@example.com", "claude", "a0", "2026-10-30", 10, 3.0),
    srow("alice@example.com", "claude", "a9", "2026-10-27", 10, 1.0),  # day 7 → in baseline
    srow("alice@example.com", "claude", "old", "2026-10-26", 10, 99.0),  # day 8 → out
]


class FakeTable:
    def __init__(self, rows=(), usage=()):
        self.rows, self.usage, self.items = list(rows), list(usage), {}

    def query(self, IndexName, KeyConditionExpression, **kw):
        assert IndexName == "date-index"
        date = KeyConditionExpression.get_expression()["values"][1]
        return {"Items": [copy.deepcopy(r) for r in self.rows if r.get("gsiDate") == date]}

    def scan(self, FilterExpression, ExpressionAttributeValues, **kw):
        v = ExpressionAttributeValues
        return {"Items": [u for u in self.usage
                          if u["PK"].startswith(v[":p"]) and u["SK"].startswith(v[":d"])]}

    def get_item(self, Key):
        it = self.items.get((Key["PK"], Key["SK"]))
        return {"Item": it} if it else {}

    def put_item(self, Item):
        self.items[(Item["PK"], Item["SK"])] = Item


USAGE = [
    {"PK": "USER#alice@example.com", "SK": f"{DATE}#claude-opus-5-5", "estimatedCost": Decimal("6.5")},
    {"PK": "USER#alice@example.com", "SK": f"{DATE}#gpt-6.1-sol", "estimatedCost": Decimal("1.5")},
    {"PK": "USER#bob@example.com", "SK": f"{DATE}#claude-opus-5-5", "estimatedCost": Decimal("2.0")},
    {"PK": "USER#carol@example.com", "SK": f"{DATE}#claude-opus-5-5", "estimatedCost": Decimal("2.0")},
    {"PK": "USER#alice@example.com", "SK": "2026-11-02#claude-opus-5-5", "estimatedCost": Decimal("50")},
    {"PK": "USER#alice@example.com", "SK": f"PROD#{DATE}", "estimatedCost": Decimal("50")},
    {"PK": "DEPT#eng", "SK": DATE, "estimatedCost": Decimal("50")},
]

GOOD = {"summary": "ok", "findings": [
    {"user": "U1", "severity": "action", "title": "t", "detail": "d", "suggestion": "s"},
    {"user": "alice@example.com", "severity": "huge", "title": "t2"}], "fleet": ["f1"]}


class FakeBedrock:
    def __init__(self, text=None, exc=None):
        self.text, self.exc, self.calls = text, exc, []

    def converse(self, **kw):
        self.calls.append(kw)
        if self.exc:
            raise self.exc
        return {"output": {"message": {"role": "assistant", "content": [{"text": self.text}]}}}


def run(event, sessions=None, usage=None, bedrock=None):
    sessions = sessions if sessions is not None else FakeTable(ROWS)
    usage = usage if usage is not None else FakeTable(usage=USAGE)
    bedrock = bedrock or FakeBedrock(json.dumps(GOOD))
    with mock.patch.object(si, "sessions_table", lambda: sessions), \
            mock.patch.object(si, "usage_table", lambda: usage), \
            mock.patch.object(si, "_bedrock_client", lambda: bedrock), \
            mock.patch.object(si, "datetime", wraps=datetime) as dt:
        dt.now.return_value = NOW
        out = si.handler(event, None)
    return out, sessions, bedrock


def test_previous_utc_date_default_and_row():
    out, t, br = run({})
    assert out == {"date": DATE, "status": "ok"}
    row = t.items[("INSIGHT#daily", DATE)]
    assert row["date"] == DATE and row["status"] == "ok" and "error" not in row
    assert row["model"] == si.INSIGHTS_MODEL_ID
    assert row["ttl"] == int(NOW.timestamp()) + 400 * 86400
    assert json.loads(row["labels"]) == {"U1": "alice@example.com", "U2": "bob@example.com"}
    ins = json.loads(row["insight"])
    assert ins["summary"] == "ok" and ins["fleet"] == ["f1"]
    # unknown user label → fleet, unknown severity → info
    assert ins["findings"][1]["user"] == "fleet" and ins["findings"][1]["severity"] == "info"
    assert br.calls[0]["modelId"] == si.INSIGHTS_MODEL_ID


def test_aggregation_numbers():
    _, t, _ = run({"date": DATE})
    stats = json.loads(t.items[("INSIGHT#daily", DATE)]["stats"])
    u1, u2 = stats["topUsers"]
    assert u1["user"] == "U1" and u1["sessions"] == 2 and u1["turns"] == 12
    assert u1["estimatedCost"] == 6.0 and u1["costPerSession"] == 3.0
    assert u1["costPerTurn"] == 0.5 and u1["avgTurnsPerSession"] == 6.0
    assert u1["maxSessionCost"] == 5.0 and u1["maxSessionTurns"] == 10
    assert u1["cacheReadRatio"] == 0.8  # 1600 / (200 + 1600 + 200)
    assert u1["tools"]["claude"]["sessions"] == 1 and u1["tools"]["codex"]["estimatedCost"] == 1.0
    assert set(u1["models"]) == {"claude-opus-5-5", "gpt-6.1-sol"}
    # baseline: 2026-10-27..2026-11-02 → 2 sessions, 20 turns, $4
    assert u1["baseline7d"] == {"sessions": 2, "costPerTurn": 0.2, "costPerSession": 2.0}
    assert u1["meteredCost"] == 8.0 and u1["coverage"] == 0.75
    assert u2["cacheReadRatio"] == 0.0 and u2["baseline7d"]["costPerTurn"] is None
    fleet = stats["fleet"]
    assert fleet["sessions"] == 3 and fleet["turns"] == 16 and fleet["estimatedCost"] == 8.0
    assert fleet["users"] == 2 and fleet["meteredCost"] == 12.0 and fleet["meteredUsers"] == 3
    assert fleet["coverage"] == round(8 / 12, 4)


def test_no_email_reaches_bedrock():
    _, _, br = run({"date": DATE})
    sent = json.dumps(br.calls[0], default=str)
    assert "@" not in sent and "alice" not in sent and "bob" not in sent
    payload = json.loads(br.calls[0]["messages"][0]["content"][0]["text"])
    assert [u["user"] for u in payload["topUsers"]] == ["U1", "U2"]
    assert "ko" in br.calls[0]["system"][0]["text"]


def test_fenced_json_accepted():
    _, t, _ = run({"date": DATE}, bedrock=FakeBedrock("```json\n" + json.dumps(GOOD) + "\n```"))
    assert t.items[("INSIGHT#daily", DATE)]["status"] == "ok"


def test_bad_json_falls_back_to_error_with_stats():
    out, t, _ = run({"date": DATE}, bedrock=FakeBedrock("Sure! Here is my analysis: none"))
    assert out["status"] == "error"
    row = t.items[("INSIGHT#daily", DATE)]
    assert row["status"] == "error" and row["error"]
    assert json.loads(row["stats"])["fleet"]["sessions"] == 3
    assert json.loads(row["insight"]) == {"summary": "", "findings": [], "fleet": []}


def test_bedrock_exception_stored_as_error():
    out, t, _ = run({"date": DATE}, bedrock=FakeBedrock(exc=RuntimeError("throttled")))
    assert out["status"] == "error" and "throttled" in t.items[("INSIGHT#daily", DATE)]["error"]


def test_idempotent_unless_force():
    _, t, br = run({"date": DATE})
    first = t.items[("INSIGHT#daily", DATE)]
    out, t, br2 = run({"date": DATE}, sessions=t)
    assert out.get("skipped") and not br2.calls and t.items[("INSIGHT#daily", DATE)] is first
    out, t, br3 = run({"date": DATE, "force": True}, sessions=t)
    assert not out.get("skipped") and len(br3.calls) == 1
    assert t.items[("INSIGHT#daily", DATE)] is not first


def test_error_row_is_retried_without_force():
    _, t, _ = run({"date": DATE}, bedrock=FakeBedrock(exc=RuntimeError("x")))
    out, t, br = run({"date": DATE}, sessions=t)
    assert out["status"] == "ok" and len(br.calls) == 1


def test_no_sessions_skips_bedrock():
    out, t, br = run({"date": "2026-10-01"})
    assert out["status"] == "ok" and not br.calls
    assert json.loads(t.items[("INSIGHT#daily", "2026-10-01")]["stats"])["fleet"]["sessions"] == 0


def test_invalid_date():
    out, t, _ = run({"date": "2026-13-45"})
    assert out["status"] == "error" and not t.items
