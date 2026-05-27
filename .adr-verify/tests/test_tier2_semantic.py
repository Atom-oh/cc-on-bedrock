import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from adrverify.tier2_semantic import (
    run_semantic_checks,
    SemanticResult,
    build_prompt,
)


def _bedrock_response(claims_payload: list[dict]) -> dict:
    """Build a fake bedrock-runtime InvokeModel response."""
    body = json.dumps({
        "content": [{
            "type": "text",
            "text": json.dumps({"adr_id": "ADR-099", "claims": claims_payload}),
        }],
    })
    return {"body": MagicMock(read=MagicMock(return_value=body.encode()))}


def test_all_claims_pass(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "sample.py").write_text("def foo():\n    pass\n")

    verification = {
        "semantic": [
            {"claim": "foo is defined", "context_files": ["src/sample.py"]},
        ]
    }

    bedrock = MagicMock()
    bedrock.invoke_model.return_value = _bedrock_response([{
        "claim": "foo is defined",
        "verdict": "pass",
        "evidence": [{"file": "src/sample.py", "line": 1, "snippet": "def foo():"}],
        "reason": "Function foo declared on line 1.",
    }])

    result = run_semantic_checks(
        adr_id="ADR-099",
        adr_full_markdown="# ADR-099\n",
        verification=verification,
        repo_root=tmp_path,
        bedrock=bedrock,
        model_id="global.anthropic.claude-opus-4-7",
    )
    assert result.status == "pass"
    assert result.claims[0]["verdict"] == "pass"
    bedrock.invoke_model.assert_called_once()


def test_any_claim_fail_makes_overall_fail(tmp_path: Path):
    verification = {"semantic": [{"claim": "x", "context_files": []}]}
    bedrock = MagicMock()
    bedrock.invoke_model.return_value = _bedrock_response([{
        "claim": "x", "verdict": "fail",
        "evidence": [], "reason": "missing in code",
    }])
    result = run_semantic_checks(
        adr_id="ADR-099", adr_full_markdown="", verification=verification,
        repo_root=tmp_path, bedrock=bedrock,
        model_id="global.anthropic.claude-opus-4-7",
    )
    assert result.status == "fail"


def test_empty_semantic_section_returns_skip(tmp_path: Path):
    bedrock = MagicMock()
    result = run_semantic_checks(
        adr_id="ADR-099", adr_full_markdown="", verification={},
        repo_root=tmp_path, bedrock=bedrock,
        model_id="global.anthropic.claude-opus-4-7",
    )
    assert result.status == "skip"
    bedrock.invoke_model.assert_not_called()


def test_invalid_json_falls_back_to_unverifiable(tmp_path: Path):
    verification = {"semantic": [{"claim": "x", "context_files": []}]}
    bedrock = MagicMock()
    bad_body = json.dumps({"content": [{"type": "text", "text": "this is not JSON"}]})
    bedrock.invoke_model.return_value = {
        "body": MagicMock(read=MagicMock(return_value=bad_body.encode())),
    }
    result = run_semantic_checks(
        adr_id="ADR-099", adr_full_markdown="", verification=verification,
        repo_root=tmp_path, bedrock=bedrock,
        model_id="global.anthropic.claude-opus-4-7",
    )
    assert result.status in ("fail", "skip")
    assert result.claims[0]["verdict"] == "unverifiable"


def test_build_prompt_includes_adr_and_context(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("CONTENT_A\n")
    verification = {
        "semantic": [
            {"claim": "claim 1", "context_files": ["src/a.py"]},
        ]
    }
    system, user = build_prompt(
        adr_id="ADR-099",
        adr_full_markdown="# ADR-099\nbody text",
        verification=verification,
        repo_root=tmp_path,
    )
    assert "verification" in system.lower() or "검증자" in system
    assert "ADR-099" in user
    assert "body text" in user
    assert "CONTENT_A" in user
    assert "claim 1" in user
