"""P1: S3-event rollup handler → DynamoDB (USER#{email}).

Mocks S3 get_object + the DynamoDB client. Asserts:
- a metrics object writes PROD#{date}#{model} (native claude_code.* 8-field set) + ACTIVE#
- a logs object writes SKILL#/AGENT#/TOOL# usage counts
- the OTELOBJ#{key}#{i} dedup marker rides in each chunk with attribute_not_exists
- no cost/ATTR# rows; counters use ADD; marker is TTL'd
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


def _attr(k, v):
    return {"key": k, "value": {"stringValue": v}}


def _dp(n, attrs):
    return {"asInt": str(n), "timeUnixNano": str(_NANO),
            "attributes": [_attr(k, v) for k, v in attrs.items()]}


def _metrics_obj():
    res = [_attr("enduser.id", "Alice@Example.com"), _attr("cc.department", "platform")]
    metrics = [
        {"name": "claude_code.lines_of_code.count",
         "sum": {"dataPoints": [_dp(10, {"type": "added", "model": "claude-opus-4-8"})]}},
        {"name": "claude_code.commit.count", "sum": {"dataPoints": [_dp(1, {})]}},
        {"name": "claude_code.session.count", "sum": {"dataPoints": [_dp(1, {})]}},
    ]
    return {"resourceMetrics": [{"resource": {"attributes": res},
                                 "scopeMetrics": [{"metrics": metrics}]}]}


def _log_rec(event, attrs):
    return {"timeUnixNano": str(_NANO),
            "attributes": [_attr("event.name", event)] + [_attr(k, v) for k, v in attrs.items()]}


def _logs_obj():
    res = [_attr("enduser.id", "Alice@Example.com")]
    recs = [
        _log_rec("claude_code.tool_result",
                 {"tool_name": "Skill", "tool_parameters": '{"skill_name":"verify"}'}),
        _log_rec("claude_code.tool_result",
                 {"tool_name": "Agent", "tool_parameters": '{"subagent_type":"Explore"}'}),
    ]
    return {"resourceLogs": [{"resource": {"attributes": res},
                              "scopeLogs": [{"logRecords": recs}]}]}


def _s3_event(key="otlp-metrics/abc.json"):
    return {"Records": [{"s3": {"bucket": {"name": "otel-metrics-raw"}, "object": {"key": key}}}]}


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
            raise ClientError({"Error": {"Code": "TransactionCanceledException"}}, "TransactWriteItems")
        return {}


def _run(ddb, payload, key="otlp-metrics/abc.json"):
    with mock.patch.object(handler_mod, "s3", _FakeS3(payload)), \
         mock.patch.object(handler_mod, "ddb", ddb):
        return handler_mod.handler(_s3_event(key), None)


def test_prod_fields_native_schema():
    assert handler_mod._PROD_FIELDS == (
        "loc_added", "loc_removed", "commits", "prs",
        "sessions", "active_seconds", "edit_accept", "edit_reject")


def test_metrics_object_writes_prod_presence_and_ttl_marker_no_cost():
    ddb = _FakeDDB()
    assert _run(ddb, _metrics_obj())["processed"] == 1
    blob = json.dumps(ddb.calls)
    assert "USER#alice@example.com" in blob          # lowercased per ADR-029
    assert f"PROD#{DATE}#claude-opus-4-8" in blob     # loc carries model
    assert f"ACTIVE#{DATE}" in blob
    assert "OTELOBJ#otlp-metrics/abc.json#0" in blob  # chunked dedup marker
    assert "attribute_not_exists" in blob
    assert "ATTR#" not in blob                        # cost stays in 005
    # marker TTL'd
    items = ddb.calls[0]
    marker = [i["Put"] for i in items
              if "Put" in i and i["Put"]["Item"]["SK"]["S"].startswith("OTELOBJ#")][0]
    assert int(marker["Item"]["ttl"]["N"]) > 0


def test_logs_object_writes_skill_agent_tool_counts():
    ddb = _FakeDDB()
    assert _run(ddb, _logs_obj())["processed"] == 1
    blob = json.dumps(ddb.calls)
    assert f"SKILL#{DATE}#verify" in blob
    assert f"AGENT#{DATE}#Explore" in blob
    assert f"TOOL#{DATE}#Skill" in blob and f"TOOL#{DATE}#Agent" in blob
    assert any(b.get("UpdateExpression", "").strip().upper().startswith("ADD")
               for it in ddb.calls[0] for b in [list(it.values())[0]] if "UpdateExpression" in b)


def test_duplicate_delivery_is_idempotent_skip():
    ddb = _FakeDDB(raise_cancel=True)
    assert _run(ddb, _metrics_obj())["processed"] == 0  # cancelled, no exception


def test_url_encoded_s3_key_is_decoded():
    ddb = _FakeDDB()
    fake_s3 = _FakeS3(_metrics_obj())
    encoded = "otlp-metrics/year%3D2026/month%3D06/m_1.json"
    event = {"Records": [{"s3": {"bucket": {"name": "otel-metrics-raw"}, "object": {"key": encoded}}}]}
    with mock.patch.object(handler_mod, "s3", fake_s3), mock.patch.object(handler_mod, "ddb", ddb):
        handler_mod.handler(event, None)
    assert fake_s3.last_key == "otlp-metrics/year=2026/month=06/m_1.json"


def test_multi_user_metrics_object_one_transaction_per_user():
    res_b = [_attr("enduser.id", "bob@example.com")]
    payload = _metrics_obj()
    payload["resourceMetrics"].append(
        {"resource": {"attributes": res_b},
         "scopeMetrics": [{"metrics": [
             {"name": "claude_code.commit.count", "sum": {"dataPoints": [_dp(1, {})]}}]}]})
    ddb = _FakeDDB()
    assert _run(ddb, payload)["processed"] == 1
    assert len(ddb.calls) == 2  # one transaction per user
    blob = json.dumps(ddb.calls)
    assert "USER#alice@example.com" in blob and "USER#bob@example.com" in blob
