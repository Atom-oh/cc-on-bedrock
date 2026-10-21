# Runbook: AI PR-Review Panel — Codex lens cells and Claude chair

> Current protocol (2026-10-21, ADR-013 amendment): CI runs the simplified `ROLE_REVIEW=0`
> path — Codex lens panel → Claude Opus 5.5 chair VERDICT — the path this runbook describes.
> Kiro is no longer in the CI panel; the earlier Kiro quota and no-tools agent-fallback
> procedures were removed with it. The specialist protocol (`ROLE_REVIEW=1`) is retained but
> inactive; see [specialist review](../pr-review-specialists.md).

## Overview
`.github/workflows/pr-review.yml` builds the diff with `git diff` from the pinned merge-base
and HEAD commits, then:

1. `scripts/pr-review/run-panel.sh` runs one Codex cell per lens L2–L5 in parallel
   (`PANEL_MODEL`, default `global.openai.gpt-6.1-sol`). Each cell reads the diff on stdin,
   runs with `-c web_search=disabled -s read-only`, gets an allowlisted environment
   (`PATH`/`HOME`/locale/`TMPDIR` plus `AWS_*` and `CODEX_*` only — no `GH_TOKEN`,
   `GITHUB_TOKEN` or `KIRO_API_KEY`), and is retried up to `PANEL_RETRIES` (default 3) times
   under a `PANEL_TIMEOUT` (default 300 s) backstop.
2. `scripts/pr-review/synthesize.sh` runs the Claude chair (`global.anthropic.claude-opus-5-5`,
   fallback `global.anthropic.claude-opus-5`, `CHAIR_TIMEOUT` default 600 s) with no tools
   (`--tools "" --strict-mcp-config`). A rejected chair attempt logs its exit code and the
   scrubbed start of its stdout/stderr (`chair_diag`). The chair receives the PR title
   (as untrusted data), the diff and the Codex cells on stdin, reviews the diff itself as the
   second independent reviewer, adjudicates the Codex findings and emits exactly one final
   `VERDICT`. The workflow checks the diff's sha256 between panel and chair, so the chair sees
   the bytes the panel reviewed.

Failures are surfaced by a banner at the top of the PR review comment and an `::error::` or
`::warning::` line in the Actions log.

This repo does not own the runner image or the Codex/Claude CLI versions. Those live in the
AWS-Demo-Platform repository (`docker/actions-runner-claude/Dockerfile`). Auth is EKS Pod
Identity (`ci-runner`) SigV4.

## Prerequisites
- Read access to the failed `AI Code Review` Actions run.

## Symptom A — `🛑 Forced FAIL — incomplete panel coverage`

Log: `::error::codex did not complete every lens — forcing VERDICT: FAIL`, and the comment
header lists fewer than four `codex/L*` cells. Codex is the only panel vendor, so any lens it
did not complete (timeout, non-zero exit, empty output after all retries, missing binary,
Bedrock auth failure) forces `VERDICT: FAIL` whatever the chair decided (fail-closed).

1. Read the `--- [codex-L*] skipped; stderr (last 25 lines, scrubbed) ---` block in the panel
   step log for the cause.
2. `::error::codex CLI not found on runner` means the runner image needs a rebuild (the
   "Verify CLIs present" step also fails in that case).
3. For transient Bedrock errors or timeouts, re-run the failed workflow.

## Symptom B — chair produced no valid review

Log: `::warning::chair 'Claude Opus 5.5' degraded (...) — falling back to 'Claude Opus 5'`;
if the fallback also fails, the comment reads `리뷰 생성 실패 — ...` followed by
`VERDICT: FAIL`. A valid chair response must end with exactly `VERDICT: PASS` or
`VERDICT: FAIL` as its last non-empty line.

1. Check the scrubbed `chair.err` excerpt in the warning line.
2. Confirm the Claude signing region matches `ANTHROPIC_BEDROCK_BASE_URL` in the workflow
   (`global.` profiles change routing only, not the SigV4 region).
3. Re-run the failed workflow.

## Symptom C — `## Review blocked` (oversized diff)

Diffs over 12,000 lines or 512,000 bytes (after lockfile/binary/build-output exclusions) are
not reviewed and the comment shows `**Status: BLOCKED**` with `VERDICT: FAIL`. They are never
truncated or reviewed as a prefix. Split the PR; do not raise the limits to obtain a pass.

## Rollback
Reverting the scripts or workflow restores whichever panel shape the reverted commit had; it
does not change account-side Bedrock access. `ROLE_REVIEW=1` selects the retained specialist
protocol instead of this path.

## Escalation
The runner image and CLI versions are managed in the AWS-Demo-Platform repository; pinning or
rebuilding the image is a change there, not here.

## Background
The panel scripts were ported from the claude-code-usage-dashboard repository PR #33 and
earlier ran a Codex × Kiro lens matrix. #127 introduced a Codex + Claude two-reviewer path; it
was reverted by #131 because the Claude panel reviewer kept exiting without the coverage
marker. The 2026-10-21 change supersedes both: Codex is the only panel vendor and Claude
reviews only as the chair. `tests/unit/test-pr-review-panel.sh` pins the current behaviour
with stub binaries (no real model calls).
