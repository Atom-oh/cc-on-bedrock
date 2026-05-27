from pathlib import Path
import pytest
from adrverify.tier1_static import (
    run_static_checks,
    StaticResult,
    StaticCheckOutcome,
)


def _make_repo(tmp_path: Path, files: dict[str, str]) -> Path:
    """Helper: create a fake repo tree under tmp_path."""
    for rel, content in files.items():
        f = tmp_path / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content)
    return tmp_path


def test_must_contain_passes(tmp_path: Path):
    repo = _make_repo(tmp_path, {"src/sample.py": "x = 'expected_string'\n"})
    verification = {
        "files": [{"path": "src/sample.py", "must_contain": ["expected_string"]}]
    }
    result = run_static_checks(verification, repo_root=repo)
    assert result.status == "pass"
    assert len(result.checks) == 1
    assert result.checks[0].result == "pass"


def test_must_contain_fails(tmp_path: Path):
    repo = _make_repo(tmp_path, {"src/sample.py": "x = 'something_else'\n"})
    verification = {
        "files": [{"path": "src/sample.py", "must_contain": ["expected_string"]}]
    }
    result = run_static_checks(verification, repo_root=repo)
    assert result.status == "fail"
    assert result.checks[0].result == "fail"
    assert "expected_string" in result.checks[0].evidence


def test_must_not_contain_passes(tmp_path: Path):
    repo = _make_repo(tmp_path, {"src/sample.py": "x = 'good'\n"})
    verification = {
        "files": [{"path": "src/sample.py", "must_not_contain": ["forbidden"]}]
    }
    result = run_static_checks(verification, repo_root=repo)
    assert result.status == "pass"


def test_must_not_contain_fails_with_evidence(tmp_path: Path):
    repo = _make_repo(tmp_path, {
        "src/a.py": "x = 'forbidden_pattern'\n",
        "src/b.py": "ok\n",
    })
    verification = {
        "files": [{
            "path": "src/**/*.py",
            "must_not_contain": ["forbidden_pattern"],
        }]
    }
    result = run_static_checks(verification, repo_root=repo)
    assert result.status == "fail"
    failed = [c for c in result.checks if c.result == "fail"]
    assert len(failed) == 1
    assert "src/a.py" in failed[0].evidence


def test_glob_path_expands(tmp_path: Path):
    repo = _make_repo(tmp_path, {
        "cdk/lib/a.ts": "good\n",
        "cdk/lib/sub/b.ts": "good\n",
    })
    verification = {
        "files": [{"path": "cdk/lib/**/*.ts", "must_contain": ["good"]}]
    }
    result = run_static_checks(verification, repo_root=repo)
    assert result.status == "pass"
    # 2 files, each with 1 must_contain rule → 2 check rows
    assert len(result.checks) == 2


def test_regex_prefix_uses_regex(tmp_path: Path):
    repo = _make_repo(tmp_path, {"src/v.py": "version = '1.2.3'\n"})
    verification = {
        "files": [{"path": "src/v.py", "must_contain": ["/version\\s*=\\s*'\\d+\\.\\d+\\.\\d+'/"]}]
    }
    result = run_static_checks(verification, repo_root=repo)
    assert result.status == "pass"


def test_must_exist_missing(tmp_path: Path):
    verification = {
        "files": [{"path": "src/missing.py", "must_exist": True}]
    }
    result = run_static_checks(verification, repo_root=tmp_path)
    assert result.status == "fail"
    assert "missing.py" in result.checks[0].evidence


def test_empty_verification_returns_skip(tmp_path: Path):
    result = run_static_checks({}, repo_root=tmp_path)
    assert result.status == "skip"
    assert result.checks == []


def test_must_exist_true_file_present_emits_pass(tmp_path: Path):
    repo = _make_repo(tmp_path, {"src/a.py": "x\n"})
    verification = {"files": [{"path": "src/a.py", "must_exist": True}]}
    result = run_static_checks(verification, repo_root=repo)
    assert result.status == "pass"
    assert len(result.checks) == 1
    assert result.checks[0].rule == "must_exist"
    assert result.checks[0].result == "pass"


def test_must_exist_false_file_present_fails(tmp_path: Path):
    repo = _make_repo(tmp_path, {"src/a.py": "x\n"})
    verification = {"files": [{"path": "src/a.py", "must_exist": False}]}
    result = run_static_checks(verification, repo_root=repo)
    assert result.status == "fail"
    assert "must_exist=False" in result.checks[0].evidence


def test_must_exist_false_file_missing_passes(tmp_path: Path):
    verification = {"files": [{"path": "src/missing.py", "must_exist": False}]}
    result = run_static_checks(verification, repo_root=tmp_path)
    assert result.status == "pass"


def test_empty_regex_raises(tmp_path: Path):
    repo = _make_repo(tmp_path, {"src/a.py": "x\n"})
    verification = {"files": [{"path": "src/a.py", "must_contain": ["//"]}]}
    with pytest.raises(ValueError, match="empty regex"):
        run_static_checks(verification, repo_root=repo)
