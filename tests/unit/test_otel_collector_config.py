"""P1-T4: the otel-collector config must (a) export both metrics and logs to S3,
(b) keep ONLY tool_result/tool_decision log events, and (c) DLP-scrub the tool events —
lifting skill_name/subagent_type to top-level and deleting the raw tool_parameters/
tool_input so no bash command / file path / prompt reaches S3 (ADR-009 no-content).
"""
import pathlib

import pytest

yaml = pytest.importorskip("yaml")

CFG = pathlib.Path(__file__).resolve().parents[2] / "docker" / "otel-collector" / "config.yaml"


def _cfg():
    return yaml.safe_load(CFG.read_text(encoding="utf-8"))


def test_has_metrics_and_logs_pipelines_to_s3():
    c = _cfg()
    pipes = c["service"]["pipelines"]
    assert "metrics" in pipes and "logs" in pipes
    for p in ("metrics", "logs"):
        assert any(e.startswith("awss3") for e in pipes[p]["exporters"]), p


def test_logs_pipeline_filters_and_scrubs():
    c = _cfg()
    procs = c["service"]["pipelines"]["logs"]["processors"]
    assert any("filter" in p for p in procs), "logs must filter to tool events only"
    assert any("transform" in p for p in procs), "logs must run the DLP scrub transform"


def test_scrub_is_break_closed_keep_only_allowlist():
    raw = CFG.read_text(encoding="utf-8")
    # lifts the two identifiers the rollup needs
    assert 'attributes["skill_name"]' in raw
    assert 'attributes["subagent_type"]' in raw
    # break-closed: keep ONLY an allowlist, so any unlisted (incl. future) field is dropped
    assert "keep_keys(attributes" in raw
    keep_line = [ln for ln in raw.splitlines() if "keep_keys(attributes" in ln][0]
    for kept in ("event.name", "tool_name", "skill_name", "subagent_type"):
        assert kept in keep_line, kept
    # sensitive payload must NOT be in the allowlist (so it is dropped)
    for sensitive in ("tool_parameters", "tool_input", "prompt", "response", "bash_command"):
        assert sensitive not in keep_line, sensitive


def test_filter_keeps_only_tool_events():
    # Keyed on the tool_name attribute (only tool_result/tool_decision carry one) rather
    # than event.name, which OTLP may put in the LogRecord event_name field instead of
    # attributes depending on version.
    c = _cfg()
    filter_key = next(p for p in c["service"]["pipelines"]["logs"]["processors"] if "filter" in p)
    conditions = c["processors"][filter_key]["logs"]["log_record"]
    # Exact match, not substring: a substring check would still pass on an unrelated or
    # negated condition that happens to contain "tool_name" — the OTTL semantics matter.
    assert conditions == ['attributes["tool_name"] == nil'], conditions
