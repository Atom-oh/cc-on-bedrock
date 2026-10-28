"""ADR-014 §9 stage 1: Codex on bedrock-mantle has no invocation log, so the tracker
estimates its cost from the AWS/BedrockMantle per-project token metrics × the price
table and writes MANTLE#{YYYY-MM} rows (SK {email}#{date}#{model}). Those rows are an estimate only: no budget or
usage reader (USER#/DEPT# prefixes) ever counts them."""
import os
import sys
import importlib
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.setdefault("AWS_REGION", "ap-northeast-2")
os.environ.setdefault("USAGE_TABLE_NAME", "cc-on-bedrock-usage")

tracker = importlib.import_module("bedrock-usage-tracker")

NOW = datetime(2026, 10, 28, 3, 0, tzinfo=timezone.utc)
ALICE = {"id": "proj_alice", "name": "cc-alice",
         "tags": {"cc-on-bedrock:user": "Alice@X.com", "cc-on-bedrock:managed": "true"}}
FOREIGN = {"id": "proj_other", "name": "someone-else", "tags": {}}


def metric(name, project, model):
    return {"MetricName": name, "Dimensions": [
        {"Name": "Project", "Value": project}, {"Name": "Model", "Value": model}]}


class FakeCw:
    def __init__(self, metrics, values):
        self.metrics, self.values, self.calls = metrics, values, []

    def get_paginator(self, op):
        assert op == "list_metrics"
        return mock.Mock(paginate=lambda **kw: [
            {"Metrics": [m for m in self.metrics if m["MetricName"] == kw["MetricName"]]}])

    def get_metric_data(self, MetricDataQueries, StartTime, EndTime, ScanBy=None, NextToken=None):
        self.calls.append((StartTime, EndTime))
        out = []
        for q in MetricDataQueries:
            m = q["MetricStat"]["Metric"]
            dims = {d["Name"]: d["Value"] for d in m["Dimensions"]}
            series = self.values.get((m["MetricName"], dims["Project"], dims["Model"]), {})
            out.append({"Id": q["Id"], "Timestamps": [datetime(2026, 10, d, tzinfo=timezone.utc) for d in series],
                        "Values": list(series.values())})
        return {"MetricDataResults": out}


def run(projects, cw):
    t = mock.Mock()
    with mock.patch.object(tracker, "MANTLE_REGION", "us-east-1"), \
         mock.patch.object(tracker, "table", t), \
         mock.patch.object(tracker, "_list_mantle_projects", lambda: projects), \
         mock.patch.object(tracker, "_cw_mantle", lambda: cw):
        out = tracker.meter_mantle(now=NOW)
    return out, t


def test_writes_an_idempotent_estimate_per_user_day_and_model():
    cw = FakeCw(
        [metric("InputTokens", "proj_alice", "openai.gpt-6.1-sol"),
         metric("OutputTokens", "proj_alice", "openai.gpt-6.1-sol")],
        {("InputTokens", "proj_alice", "openai.gpt-6.1-sol"): {27: 1_000_000, 28: 500_000},
         ("OutputTokens", "proj_alice", "openai.gpt-6.1-sol"): {28: 100_000}})
    out, t = run([ALICE], cw)
    assert out == {"rows": 2}
    rows = {c.kwargs["Key"]["SK"]: c.kwargs for c in t.update_item.call_args_list}
    today = rows["alice@x.com#2026-10-28#gpt-6.1-sol"]
    assert today["Key"]["PK"] == "MANTLE#2026-10"  # never USER#: budgets don't see it
    vals = today["ExpressionAttributeValues"]
    assert vals[":email"] == "alice@x.com"
    assert vals[":inp"] == 500_000 and vals[":out"] == 100_000
    # gpt-6.1-sol: $2 in / $10 out per 1M → 1.0 + 1.0
    assert float(vals[":cost"]) == 2.0
    assert today["UpdateExpression"].startswith("SET ")  # absolute totals, safe to re-run
    assert "ADD" not in today["UpdateExpression"]
    assert float(rows["alice@x.com#2026-10-27#gpt-6.1-sol"]["ExpressionAttributeValues"][":cost"]) == 2.0
    start, end = cw.calls[0]
    assert start == datetime(2026, 10, 27, tzinfo=timezone.utc) and end == NOW


def test_ignores_projects_it_does_not_manage():
    cw = FakeCw([metric("InputTokens", "proj_other", "openai.gpt-6.1-sol")],
                {("InputTokens", "proj_other", "openai.gpt-6.1-sol"): {28: 10}})
    out, t = run([ALICE, FOREIGN], cw)
    assert out == {"rows": 0}
    t.update_item.assert_not_called()


def test_disabled_without_a_mantle_region():
    with mock.patch.object(tracker, "MANTLE_REGION", ""):
        assert tracker.meter_mantle(now=NOW) == {"skipped": "mantle disabled"}


def test_handler_routes_the_schedule_event():
    with mock.patch.object(tracker, "meter_mantle", return_value={"rows": 3}) as m:
        assert tracker.handler({"source": "cc.mantle-meter"}, None) == {"rows": 3}
    m.assert_called_once_with()
