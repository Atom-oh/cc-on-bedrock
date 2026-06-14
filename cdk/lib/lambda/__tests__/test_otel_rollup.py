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


def _sum_metric(name, dps):
    return {"name": name, "sum": {"dataPoints": dps}}


def _fixture():
    res_attrs = [_attr("enduser.id", "Alice@Example.com"), _attr("department", "platform"),
                 _attr("service.name", "claude-code")]
    metrics = [
        _sum_metric("claude_code.lines_of_code.count", [
            _dp(12, {"type": "added", "model": "claude-sonnet-4-6"}),
            _dp(3, {"type": "removed", "model": "claude-sonnet-4-6"}),
            _dp(5, {"type": "added", "model": "claude-sonnet-4-6"}),  # delta sum -> added 17
        ]),
        _sum_metric("claude_code.commit.count", [_dp(2, {})]),
        _sum_metric("claude_code.pull_request.count", [_dp(1, {})]),
        _sum_metric("claude_code.session.count", [_dp(1, {"start_type": "fresh"})]),
        _sum_metric("claude_code.active_time.total", [_dp(90, {"type": "user"}),
                                                      _dp(30, {"type": "cli"})]),
        _sum_metric("claude_code.code_edit_tool.decision", [
            _dp(4, {"decision": "accept", "tool_name": "Edit"}),
            _dp(1, {"decision": "reject", "tool_name": "Write"}),
        ]),
        _sum_metric("claude_code.cost.usage", [_dp(1, {"model": "claude-sonnet-4-6",
                                                       "skill.name": "code-review"})]),
    ]
    return {"resourceMetrics": [
        {"resource": {"attributes": res_attrs},
         "scopeMetrics": [{"metrics": metrics}]}]}


def test_parse_merges_resource_and_datapoint_attrs():
    recs = rollup.parse_otlp_metrics(_fixture())
    assert recs, "should yield datapoint records"
    loc = [r for r in recs if r["metric"] == "claude_code.lines_of_code.count"][0]
    # resource attrs and datapoint attrs are both present on the record
    assert loc["attrs"]["enduser.id"] == "Alice@Example.com"
    assert loc["attrs"]["department"] == "platform"
    assert loc["attrs"]["type"] == "added"
    assert loc["date"] == EXPECTED_DATE
    assert loc["value"] == 12


def test_aggregate_daily_sums_deltas_by_email_date_model():
    recs = rollup.parse_otlp_metrics(_fixture())
    agg = rollup.aggregate_daily(recs)
    # email is taken raw here (lowercasing is T2's normalize_identity)
    key = ("Alice@Example.com", EXPECTED_DATE, "claude-sonnet-4-6")
    assert key in agg
    row = agg[key]
    assert row["loc_added"] == 17  # 12 + 5
    assert row["loc_removed"] == 3
    # metrics without a model attr bucket under model="_"
    nomodel = agg[("Alice@Example.com", EXPECTED_DATE, "_")]
    assert nomodel["commits"] == 2
    assert nomodel["prs"] == 1
    assert nomodel["sessions"] == 1
    assert nomodel["active_seconds"] == 120  # 90 + 30
    assert nomodel["edit_accept"] == 4
    assert nomodel["edit_reject"] == 1


def test_extract_presence_is_unique_email_date():
    recs = rollup.parse_otlp_metrics(_fixture())
    pres = rollup.extract_presence(recs)
    assert ("Alice@Example.com", EXPECTED_DATE) in pres
    assert len(pres) == 1


def test_extract_cost_attribution_by_dimension():
    recs = rollup.parse_otlp_metrics(_fixture())
    cost = rollup.extract_cost_attribution(recs)
    # cost.usage attributed to the skill dimension when present
    key = ("Alice@Example.com", EXPECTED_DATE, "skill:code-review")
    assert key in cost
    assert cost[key]["cost_usd"] == 1
