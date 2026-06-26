"""P1: parse OTEL log events (claude_code.tool_result/tool_decision) into
per-user skill/agent/tool usage counts. Shape from the T0 Bedrock capture:
resourceLogs[].scopeLogs[].logRecords[] with an `attributes[]` list, event name in
`event.name`, tool_name + a `tool_parameters` JSON string (skill_name/subagent_type).
"""
import os
import sys
import importlib
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
rollup = importlib.import_module("otel_rollup")

NANO = "1780392600000000000"
DATE = datetime.fromtimestamp(int(NANO) / 1e9, tz=timezone.utc).strftime("%Y-%m-%d")


def _attr(k, v):
    return {"key": k, "value": {"stringValue": v}}


def _record(event, attrs, nano=NANO):
    return {"timeUnixNano": nano,
            "attributes": [_attr("event.name", event)] + [_attr(k, v) for k, v in attrs.items()]}


def _logs_fixture():
    res = [_attr("enduser.id", "Alice@Example.com")]
    records = [
        # Skill tool completion
        _record("claude_code.tool_result",
                {"tool_name": "Skill", "success": "true",
                 "tool_parameters": '{"skill_name":"verify"}'}),
        # Agent tool completion
        _record("claude_code.tool_result",
                {"tool_name": "Agent", "success": "true",
                 "tool_parameters": '{"subagent_type":"Explore"}'}),
        # a rejected Bash decision (no result event)
        _record("claude_code.tool_decision",
                {"tool_name": "Bash", "decision": "reject",
                 "tool_parameters": '{"bash_command":"rm"}'}),
        # noise event that must be ignored
        _record("claude_code.api_request", {"model": "claude-opus-4-8"}),
    ]
    return {"resourceLogs": [{"resource": {"attributes": res},
                              "scopeLogs": [{"logRecords": records}]}]}


def test_parse_otlp_logs_parses_tool_parameters_json():
    recs = rollup.parse_otlp_logs(_logs_fixture())
    skill = [r for r in recs if r["attrs"].get("tool_name") == "Skill"][0]
    assert skill["event"] == "claude_code.tool_result"
    assert skill["attrs"]["_tool_parameters"]["skill_name"] == "verify"
    assert skill["date"] == DATE


def test_aggregate_tool_events_counts_skill_agent_tool():
    counts = rollup.aggregate_tool_events(rollup.parse_otlp_logs(_logs_fixture()))
    assert counts[("Alice@Example.com", DATE, "skill", "verify")]["count"] == 1
    assert counts[("Alice@Example.com", DATE, "agent", "Explore")]["count"] == 1
    assert counts[("Alice@Example.com", DATE, "tool", "Skill")]["count"] == 1
    assert counts[("Alice@Example.com", DATE, "tool", "Agent")]["count"] == 1
    # rejected Bash decision: no result -> count 0, reject 1
    bash = counts[("Alice@Example.com", DATE, "tool", "Bash")]
    assert bash["count"] == 0 and bash["reject"] == 1


def test_non_tool_events_ignored():
    counts = rollup.aggregate_tool_events(rollup.parse_otlp_logs(_logs_fixture()))
    assert not any(k[3] == "claude-opus-4-8" for k in counts)


def test_scrubbed_shape_skill_agent_top_level():
    # Post-collector-scrub: skill_name/subagent_type are lifted to TOP-LEVEL attrs and
    # the raw tool_parameters bag is gone. The aggregator must still count them.
    res = [_attr("enduser.id", "alice@example.com")]
    recs = [
        _record("claude_code.tool_result", {"tool_name": "Skill", "skill_name": "verify"}),
        _record("claude_code.tool_result", {"tool_name": "Agent", "subagent_type": "Explore"}),
    ]
    payload = {"resourceLogs": [{"resource": {"attributes": res},
                                 "scopeLogs": [{"logRecords": recs}]}]}
    counts = rollup.aggregate_tool_events(rollup.parse_otlp_logs(payload))
    assert counts[("alice@example.com", DATE, "skill", "verify")]["count"] == 1
    assert counts[("alice@example.com", DATE, "agent", "Explore")]["count"] == 1
