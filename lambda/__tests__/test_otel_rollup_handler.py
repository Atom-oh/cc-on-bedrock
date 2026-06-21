"""Phase 1: S3-event rollup handler → DynamoDB (USER#{email}).

Mocks S3 get_object + the DynamoDB client. Asserts:
- PROD#{date}#{model} rows use ADD for delta counters
- ACTIVE#{date} presence is written (feeds DAU/WAU/MAU)
- the OTELOBJ#{key} dedup marker rides in the SAME transaction with
  attribute_not_exists, so a duplicate S3 delivery is an idempotent skip.
"""
import io
import json
import os
import sys
import importlib
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_NANO = 1780392600000000000
DATE = datetime.fromtimestamp(_NANO / 1e9, tz=timezone.utc).strftime("%Y-%m-%d")
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("USAGE_TABLE_NAME", "cc-on-bedrock-usage")

handler_mod = importlib.import_module("otel-metrics-rollup")


def _otlp():
    def attr(k, v):
        return {"key": k, "value": {"stringValue": v}}

    def dp(n, attrs):
        return {"asInt": str(n), "timeUnixNano": "1780392600000000000",
                "attributes": [attr(k, v) for k, v in attrs.items()]}
    res = [attr("enduser.id", "Alice@Example.com"), attr("department", "platform")]
    metrics = [
        {"name": "claude_code.lines_of_code.count",
         "sum": {"dataPoints": [dp(10, {"type": "added", "model": "claude-sonnet-4-6"})]}},
        {"name": "claude_code.commit.count", "sum": {"dataPoints": [dp(1, {})]}},
        {"name": "claude_code.session.count", "sum": {"dataPoints": [dp(1, {})]}},
    ]
    return {"resourceMetrics": [{"resource": {"attributes": res},
                                 "scopeMetrics": [{"metrics": metrics}]}]}


def _s3_event(bucket="otel-metrics-raw", key="2026/06/14/abc.json"):
    return {"Records": [{"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}]}


class _FakeS3:
    def __init__(self, payload):
        self._payload = payload
        self.last_key = None

    def get_object(self, Bucket, Key):
        self.last_key = Key
        return {"Body": io.BytesIO(json.dumps(self._payload).encode())}


class _FakeDDB:
    def __init__(self, raise_cancel=False):
        self.calls = []
        self._raise = raise_cancel

    def transact_write_items(self, TransactItems):
        self.calls.append(TransactItems)
        if self._raise:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "TransactionCanceledException"}},
                              "TransactWriteItems")
        return {}


def _run(ddb, payload=None):
    with mock.patch.object(handler_mod, "s3", _FakeS3(payload or _otlp())), \
         mock.patch.object(handler_mod, "ddb", ddb):
        return handler_mod.handler(_s3_event(), None)


def _flatten(items):
    """Return (verb, key_dict, item_or_update) tuples for assertions."""
    out = []
    for it in items:
        verb = next(iter(it))
        body = it[verb]
        out.append((verb, body))
    return out


def test_writes_prod_presence_and_marker_in_one_transaction():
    ddb = _FakeDDB()
    res = _run(ddb)
    assert res["processed"] == 1
    assert len(ddb.calls) == 1
    items = ddb.calls[0]
    blob = json.dumps(items)
    # email lowercased per ADR-029
    assert "USER#alice@example.com" in blob
    assert f"PROD#{DATE}#claude-sonnet-4-6" in blob
    assert f"ACTIVE#{DATE}" in blob
    # dedup marker present with attribute_not_exists condition, in the same transaction
    assert "OTELOBJ#2026/06/14/abc.json" in blob
    assert "attribute_not_exists" in blob
    # delta counters use ADD
    assert any(b.get("UpdateExpression", "").strip().upper().startswith("ADD")
               for verb, b in _flatten(items) if verb == "Update")


def test_duplicate_delivery_is_idempotent_skip():
    ddb = _FakeDDB(raise_cancel=True)  # marker already exists -> transaction cancelled
    res = _run(ddb)
    assert res["processed"] == 0  # skipped, no exception raised


def _otlp_two_users():
    def attr(k, v):
        return {"key": k, "value": {"stringValue": v}}

    def dp(n):
        return {"asInt": str(n), "timeUnixNano": "1780392600000000000", "attributes": []}

    def block(email):
        return {"resource": {"attributes": [attr("enduser.id", email)]},
                "scopeMetrics": [{"metrics": [
                    {"name": "claude_code.commit.count", "sum": {"dataPoints": [dp(1)]}}]}]}
    return {"resourceMetrics": [block("alice@example.com"), block("bob@example.com")]}


def test_url_encoded_s3_key_is_decoded():
    # Collector writes Hive-style keys (year=2026/...); S3 events arrive percent-encoded.
    ddb = _FakeDDB()
    fake_s3 = _FakeS3(_otlp())
    encoded = "otlp-metrics/year%3D2026/month%3D06/day%3D16/metricsmetrics_1.json"
    event = {"Records": [{"s3": {"bucket": {"name": "otel-metrics-raw"},
                                 "object": {"key": encoded}}}]}
    with mock.patch.object(handler_mod, "s3", fake_s3), \
         mock.patch.object(handler_mod, "ddb", ddb):
        handler_mod.handler(event, None)
    assert fake_s3.last_key == "otlp-metrics/year=2026/month=06/day=16/metricsmetrics_1.json"


def test_multi_user_object_writes_one_transaction_per_user():
    # A central collector batches many users into one S3 object; each user must be its
    # own transaction (no 100-item ceiling, per-user idempotency).
    ddb = _FakeDDB()
    res = _run(ddb, payload=_otlp_two_users())
    assert res["processed"] == 1          # one S3 object
    assert len(ddb.calls) == 2            # one transaction per user
    blob = json.dumps(ddb.calls)
    assert "USER#alice@example.com" in blob and "USER#bob@example.com" in blob
