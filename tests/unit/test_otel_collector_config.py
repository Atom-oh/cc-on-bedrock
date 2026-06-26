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


def test_scrub_lifts_skill_agent_and_drops_sensitive_fields():
    raw = CFG.read_text(encoding="utf-8")
    # lifts the two identifiers the rollup needs
    assert 'attributes["skill_name"]' in raw
    assert 'attributes["subagent_type"]' in raw
    # drops the raw bags / content
    for dropped in ("tool_parameters", "tool_input", "prompt", "response"):
        assert f'delete_key(attributes, "{dropped}")' in raw, dropped


def test_filter_keeps_only_tool_events():
    raw = CFG.read_text(encoding="utf-8")
    assert "claude_code.tool_result" in raw
    assert "claude_code.tool_decision" in raw
