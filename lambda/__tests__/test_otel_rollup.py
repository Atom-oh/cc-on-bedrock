"""Phase 1 (productivity monitoring): pure OTLP metric aggregation.

`otel_rollup` parses the OTLP/JSON that the ADOT collector's awss3 exporter writes
and aggregates Claude Code productivity counters into daily, email-keyed rollups.
No boto3 at import time — these are pure functions.

Datapoint shape mirrors the Phase-0 spike: resource attributes carry the injected
`enduser.id` (email) and `department`; datapoint attributes carry `type`/`model`.
"""
import os
import sys
import importlib
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
rollup = importlib.import_module("otel_rollup")

# A fixed export timestamp; the expected date is derived from it (no hardcoding).
NANO = "1780392600000000000"  # some instant
EXPECTED_DATE = datetime.fromtimestamp(int(NANO) / 1e9, tz=timezone.utc).strftime("%Y-%m-%d")


def _attr(key, s):
    return {"key": key, "value": {"stringValue": s}}


def _dp(value_int, attrs, nano=NANO):
    return {"asInt": str(value_int), "timeUnixNano": nano,
            "attributes": [_attr(k, v) for k, v in attrs.items()]}


def _metric(name, dps):
    return {"name": name, "sum": {"dataPoints": dps}}


def _fixture():
    # Native Claude Code OTEL: resource carries the stamped enduser.id (T0-confirmed),
    # lines_of_code carries type/model datapoint attrs, others bucket under model="_".
    res_attrs = [_attr("enduser.id", "Alice@Example.com"), _attr("cc.department", "platform"),
                 _attr("service.name", "claude-code")]
    metrics = [
        _metric("claude_code.lines_of_code.count", [
            _dp(12, {"type": "added", "model": "claude-opus-4-8"}),
            _dp(5, {"type": "added", "model": "claude-opus-4-8"}),
            _dp(3, {"type": "removed", "model": "claude-opus-4-8"})]),
        _metric("claude_code.commit.count", [_dp(2, {})]),
        _metric("claude_code.pull_request.count", [_dp(1, {})]),
        _metric("claude_code.session.count", [_dp(1, {})]),
        _metric("claude_code.active_time.total", [_dp(90, {"type": "user"}), _dp(30, {"type": "cli"})]),
        _metric("claude_code.code_edit_tool.decision", [
            _dp(4, {"decision": "accept"}), _dp(1, {"decision": "reject"})]),
    ]
    return {"resourceMetrics": [
        {"resource": {"attributes": res_attrs},
         "scopeMetrics": [{"metrics": metrics}]}]}


def test_parse_merges_resource_and_datapoint_attrs():
    recs = rollup.parse_otlp_metrics(_fixture())
    assert recs, "should yield datapoint records"
    loc = [r for r in recs if r["metric"] == "claude_code.lines_of_code.count"][0]
    assert loc["attrs"]["enduser.id"] == "Alice@Example.com"
    assert loc["attrs"]["cc.department"] == "platform"
    assert loc["attrs"]["type"] == "added"
    assert loc["date"] == EXPECTED_DATE
    assert loc["value"] == 12


def test_aggregate_daily_native_schema():
    agg = rollup.aggregate_daily(rollup.parse_otlp_metrics(_fixture()))
    row = agg[("Alice@Example.com", EXPECTED_DATE, "claude-opus-4-8")]
    assert row["loc_added"] == 17  # 12 + 5
    assert row["loc_removed"] == 3
    nm = agg[("Alice@Example.com", EXPECTED_DATE, "_")]
    assert nm["commits"] == 2
    assert nm["prs"] == 1
    assert nm["sessions"] == 1
    assert nm["active_seconds"] == 120  # 90 + 30
    assert nm["edit_accept"] == 4
    assert nm["edit_reject"] == 1


def test_extract_presence_is_unique_email_date():
    recs = rollup.parse_otlp_metrics(_fixture())
    pres = rollup.extract_presence(recs)
    assert ("Alice@Example.com", EXPECTED_DATE) in pres
    assert len(pres) == 1


def test_cost_attribution_stays_removed():
    assert not hasattr(rollup, "extract_cost_attribution")


# --- T2: email-key identity normalization + unverified flag (ADR-029) ---

def test_normalize_identity_lowercases_and_validates():
    assert rollup.normalize_identity({"enduser.id": "Alice@Example.com"}) == "alice@example.com"
    assert rollup.normalize_identity({"enduser.id": "  BOB@x.io "}) == "bob@x.io"
    # missing or non-email -> None (caller buckets as "unattributed")
    assert rollup.normalize_identity({}) is None
    assert rollup.normalize_identity({"enduser.id": "not-an-email"}) is None
    assert rollup.normalize_identity({"enduser.id": ""}) is None


def test_is_unverified_cross_checks_bedrock_usage():
    bedrock_seen = {("alice@example.com", "2026-06-14")}
    # productivity exists but no Bedrock usage that day -> suspicious
    assert rollup.is_unverified("bob@example.com", "2026-06-14", bedrock_seen) is True
    # matched in the Bedrock invocation logs -> verified
    assert rollup.is_unverified("alice@example.com", "2026-06-14", bedrock_seen) is False
