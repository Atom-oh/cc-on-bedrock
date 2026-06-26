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


def _gauge_metric(name, dps):
    return {"name": name, "gauge": {"dataPoints": dps}}


def _fixture():
    res_attrs = [_attr("enduser.id", "Alice@Example.com"), _attr("cc.department", "platform"),
                 _attr("service.name", "cc-on-bedrock-productivity")]
    metrics = [
        _gauge_metric("cc.git.lines_added", [_dp(12, {}), _dp(5, {})]),   # sum -> 17
        _gauge_metric("cc.git.lines_deleted", [_dp(3, {})]),
        _gauge_metric("cc.git.commits", [_dp(1, {}), _dp(1, {})]),        # sum -> 2
        _gauge_metric("cc.git.pushes", [_dp(1, {})]),
        _gauge_metric("cc.claude.sessions.started", [_dp(1, {})]),
        _gauge_metric("cc.claude.active_minutes", [_dp(5, {}), _dp(5, {})]),  # 10 min -> 600 s
    ]
    return {"resourceMetrics": [
        {"resource": {"attributes": res_attrs},
         "scopeMetrics": [{"metrics": metrics}]}]}


def test_parse_merges_resource_and_datapoint_attrs():
    recs = rollup.parse_otlp_metrics(_fixture())
    assert recs, "should yield datapoint records"
    commit = [r for r in recs if r["metric"] == "cc.git.commits"][0]
    assert commit["attrs"]["enduser.id"] == "Alice@Example.com"
    assert commit["attrs"]["cc.department"] == "platform"
    assert commit["date"] == EXPECTED_DATE
    assert commit["value"] == 1


def test_aggregate_daily_sums_cc_counters_under_model_underscore():
    recs = rollup.parse_otlp_metrics(_fixture())
    agg = rollup.aggregate_daily(recs)
    key = ("Alice@Example.com", EXPECTED_DATE, "_")  # cc.* counters carry no model
    assert key in agg
    row = agg[key]
    assert row["loc_added"] == 17    # 12 + 5
    assert row["loc_removed"] == 3
    assert row["commits"] == 2
    assert row["pushes"] == 1
    assert row["sessions"] == 1
    assert row["active_seconds"] == 600  # (5 + 5) minutes * 60


def test_extract_presence_is_unique_email_date():
    recs = rollup.parse_otlp_metrics(_fixture())
    pres = rollup.extract_presence(recs)
    assert ("Alice@Example.com", EXPECTED_DATE) in pres
    assert len(pres) == 1


def test_cost_attribution_removed():
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
