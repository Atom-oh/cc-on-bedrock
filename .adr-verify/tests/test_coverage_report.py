from adrverify.coverage_report import render_comment


def test_render_all_pass():
    tier1 = {"adrs": [
        {"adr_id": "ADR-021", "tier1_static": {"status": "pass", "checks": [
            {"path": "cdk/lib/02-security-stack.ts", "rule": "must_contain",
             "value": "*anthropic.claude-*", "result": "pass",
             "evidence": "line 139"},
        ]}},
    ]}
    tier2 = {"adrs": [
        {"adr_id": "ADR-021", "tier2_semantic": {"status": "pass", "claims": [
            {"claim": "x", "verdict": "pass", "evidence": [], "reason": "ok"},
        ]}},
    ]}
    out = render_comment(tier1, tier2, total_adrs=24)
    assert "ADR-021" in out
    assert "Coverage: 1/24" in out
    assert "1 pass" in out


def test_render_skip_doesnt_count():
    tier1 = {"adrs": [
        {"adr_id": "ADR-099", "tier1_static": {"status": "skip", "checks": []}},
        {"adr_id": "ADR-021", "tier1_static": {"status": "pass", "checks": []}},
    ]}
    tier2 = {"adrs": [
        {"adr_id": "ADR-099", "tier2_semantic": {"status": "skip", "claims": []}},
        {"adr_id": "ADR-021", "tier2_semantic": {"status": "pass", "claims": []}},
    ]}
    out = render_comment(tier1, tier2, total_adrs=24)
    assert "Coverage: 1/24" in out
    assert "1 skipped" in out


def test_render_fail_shown_with_evidence():
    tier1 = {"adrs": [
        {"adr_id": "ADR-014",
         "tier1_static": {"status": "pass", "checks": []}},
    ]}
    tier2 = {"adrs": [
        {"adr_id": "ADR-014",
         "tier2_semantic": {"status": "fail", "claims": [
             {"claim": "STS issues 8h credentials",
              "verdict": "fail",
              "evidence": [{"file": "cdk/lib/lambda/sts-issuer.py",
                            "line": 57,
                            "snippet": "SESSION_DURATION_SECONDS = 3600"}],
              "reason": "Code uses 1h (role-chaining cap); ADR text is stale."},
         ]}},
    ]}
    out = render_comment(tier1, tier2, total_adrs=24)
    assert "❌" in out
    assert "ADR-014" in out
    assert "role-chaining cap" in out
    assert "sts-issuer.py:57" in out


def test_render_marker_sticky():
    # The comment must carry a sticky marker so GitHub Actions can find +
    # update it on subsequent runs instead of stacking new comments.
    out = render_comment({"adrs": []}, {"adrs": []}, total_adrs=24)
    assert "<!-- adr-verify-comment -->" in out
