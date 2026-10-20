# Diagnose the two-reviewer PR gate

Automatic CI runs Codex and Claude once each over the complete in-scope diff and
all four checklists. A tool-free Claude chair combines the reports. Kiro is not
installed, authenticated or called by this workflow; its quota is irrelevant to
this gate. The shared runner may still contain software used by other projects.

## Expected execution

1. Checkout the trusted default-branch BASE revision.
2. Fetch immutable merge-base/HEAD Git objects; treat PR changes as data.
3. Send identical BASE context and diff to the two reviewers in parallel.
4. Require successful process exits, substantive L2/L3/L4/L5 sections and one
   `LENS_COVERAGE: L2,L3,L4,L5` marker from each reviewer.
5. Run the Claude chair with no tools, MCP or settings sources.
6. Validate exactly one final `VERDICT: PASS|FAIL`, check the current PR HEAD, and
   upsert the bot-owned review comment. Blocking findings fail `AI Code Review`.

The workflow uses a fresh temporary directory for every run and removes it
afterward. Raw provider output is never uploaded as an artifact. Reports are
secret-scrubbed before synthesis or publication.

## Missing or failed reviewer

The runner must supply both `codex` and `claude`. Missing CLIs fail preparation.
Empty output, nonzero exit, timeout, malformed sections or an oversized report
are retried at most twice, with a 300-second cap per attempt. A single surviving
reviewer cannot pass; the chair is skipped and a blocked report is produced.

Check runner CLI availability and Bedrock credentials/model access. The Codex
model defaults to `global.openai.gpt-6-astra`; the Claude reviewer defaults to
`global.anthropic.claude-opus-5`. These are configured IDs, not provider attestations.
Do not bypass coverage validation to make a run green.

## Input or output budget exceeded

The in-scope diff is limited to 12,000 lines and 512,000 bytes. The established
lockfile, binary and generated-directory exclusions apply before admission.
Combined BASE context is limited to 32 KiB; each report to 60,000 bytes.

Inputs and reports are not silently truncated. Reduce the PR scope or shorten
the canonical context when a budget is exceeded. All four checklist files and
the common prompt are mandatory, even for a documentation-only PR; reviewers
can explain why a category has no applicable change.

## Chair failure

The primary is `global.anthropic.claude-fable-5-1`; the fallback is
`global.anthropic.claude-opus-5`. Each gets at most 600 seconds. Equal primary and
fallback IDs are called once. A failed process cannot pass even if it prints a
valid-looking verdict. Missing, multiple or misplaced verdict lines block.

Resolve the runner/provider failure and rerun. A correctly completed FAIL for
CRITICAL/MAJOR findings is not a transport failure; address those findings.

## Stale review

If the PR HEAD changed during review, the workflow refuses to publish its result.
Use the run for the latest commit. Changing the diff after the panel ran also
blocks synthesis. Keep the branch-protection check name `AI Code Review`.

## Local verification

```bash
bash tests/unit/test-pr-review-panel.sh
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v
```

These tests use local CLI stubs and mocks, not live provider or AWS calls.
The separately retained specialist executors are documented in
`docs/pr-review-specialists.md`; `ROLE_REVIEW=1` no longer switches automatic CI
back to that protocol.
