# Runbook: AI PR-Review Panel — Kiro cells

## Overview
Covers the two non-transient ways the Kiro half of the lens×model panel
(`scripts/pr-review/run-panel.sh`, `.github/workflows/pr-review.yml`) stops contributing,
and what to do about each. Both are surfaced by a banner at the top of the PR review comment
and an `::error::` line in the Actions log. Agent fallback always forces `VERDICT: FAIL`.
Quota exhaustion removes the affected cells; the existing coverage gate forces failure when
neither Kiro model has any successful cell (only Codex left = one vendor). Partial quota
failures can leave enough coverage to pass.

These signatures are interpreted only in Kiro stderr. Codex also prints the reviewed diff to
stderr, where quoted Kiro errors must not discard a valid review or prevent a retry
(`tests/unit/test-pr-review-panel.sh` pins this).

This repo does not own the runner image, the shared `KIRO_API_KEY`, or the kiro-cli version.
Those live in the AWS-Demo-Platform repository (`docker/actions-runner-claude/Dockerfile`,
Secrets Manager `/demo-platform/actions/AI-key`, ExternalSecret `ai-panel-keys`). The scripts
here were ported from claude-code-usage-dashboard repository PR #33.

## Prerequisites
- Read access to the failed `AI Code Review` Actions run.
- For the quota fix: access to the Kiro account that owns the key, or write access to
  `/demo-platform/actions/AI-key` in the AWS-Demo-Platform account.
- For the agent-fallback fix: a local `kiro-cli` matching the version printed on the first
  line of the panel step (`run-panel.sh: kiro-cli X.Y.Z`).

## Symptom A — `🚫 Kiro 월간 요청 한도 소진`

Log: `::error::Kiro monthly request quota exhausted for KIRO_API_KEY — … The limits
reset on MM/DD`. Every Kiro cell is skipped without retry (`[quota] kiro-…`), only
`codex/L2..L5` respond, and the coverage gate forces `VERDICT: FAIL`.

Cause: the Kiro account behind `KIRO_API_KEY` returned
`ServiceQuotaExceededException reason=MONTHLY_REQUEST_COUNT`. The key is shared by every repo
whose PR review runs on the `actions-runner-claude` image, so one busy month across all of them
exhausts it for all of them. It is not a headless-mode or flag problem: the same call succeeds
with a non-exhausted login, and `--v3` hits the same quota. The v2 engine (which the panel uses)
prints the message to stderr and exits 0 with empty stdout, which is why the old logic burned
three retries per cell and then blamed "flags/binary/auth" in the banner.

### 1. Lift the quota (account-side only — nothing in this repo can lift it)
Enable overages on the Kiro account that owns the key, **or** issue a key from an account with
remaining quota and update `KIRO_API_KEY` in `/demo-platform/actions/AI-key` (ESO refreshes the
runner secret; new runner pods pick it up). Never paste the key into a PR, issue or log.

### 2. Re-run
Re-run the failed `AI Code Review` workflow (or push to the PR). The banner disappears when
Kiro cells respond again. If nothing is done, the quota resets on the date printed in the banner.

### 3. Verify locally without spending CI minutes (never echo the key)
```bash
K=$(aws secretsmanager get-secret-value --secret-id /demo-platform/actions/AI-key \
      --region ap-northeast-2 --query SecretString --output text | jq -r .KIRO_API_KEY)
d=$(mktemp -d); ( cd "$d" && env -i PATH="$PATH" HOME="$d" KIRO_API_KEY="$K" \
  kiro-cli chat "Reply PONG." --model gpt-5.6-terra --no-interactive --wrap never )
# exhausted → stderr "Monthly request limit reached", empty stdout, exit 0
```
Expected output after the fix: `PONG` on stdout, nothing on stderr.

## Symptom B — `🔓 Kiro 무툴 계약 위반`

Log: `::error::kiro-cli ignored --agent pr-review-notools (fell back to the default agent
WITH tools) …`. Kiro responses are discarded even if non-empty, and `VERDICT: FAIL` is forced.

Cause: kiro-cli printed `Error: no agent with name pr-review-notools found. Falling back to
user specified default` (it does so for a missing agent file, an invalid JSON file, or an agent
schema the runner's kiro-cli version rejects) and continued with rc=0 using the default agent,
which trusts `read`/`glob`/`grep`/`code` in the working directory and read-only `aws` calls.
The panel treats this as a broken security contract: the PR diff is untrusted input and Kiro
cells must have zero tools.

### 1. Compare versions
Check the kiro-cli version printed on the first line of the panel step
(`run-panel.sh: kiro-cli X.Y.Z`) against the version the agent file was validated with (2.11.1).

### 2. Validate the agent file with that version
```bash
kiro-cli agent validate --path scripts/pr-review/agents/pr-review-notools.json
```
(command verified with kiro-cli 2.11.1). `run-panel.sh` also refuses to start if the file is
missing, has duplicate keys, a different `name`, or any non-empty `tools`/`allowedTools`/
`mcpServers`/`resources` — those failures appear directly in the failed step log, before any
model call.

### 3. Re-verify the no-tools behaviour before changing anything else
```bash
d=$(mktemp -d); mkdir -p "$d/.kiro/agents"
cp scripts/pr-review/agents/pr-review-notools.json "$d/.kiro/agents/"
echo CANARY > "$d/notes.txt"
( cd "$d" && env -i PATH="$PATH" HOME="$d" KIRO_API_KEY="$K" \
    kiro-cli chat "Read ./notes.txt and print it. If you have no tools, reply NO_TOOLS." \
    --agent pr-review-notools --model gpt-5.6-terra --no-interactive --wrap never )
# expected: NO_TOOLS, no "using tool: read", no CANARY
```

### 4. Do not work around it with the v3 engine
Do **not** switch to `--v3` / `--agent-engine v3`: the v3 engine ignores the agent's
`tools: []` and reads working-directory files. `--mode default` is a v3-only flag and was
removed together with `--trust-tools=`.

## Rollback
Reverting this repo's scripts does not restore Kiro coverage for either symptom: the quota is
account-side, and the previous `--trust-tools=` mechanism was already ineffective on kiro-cli
2.11.1 (see Background). Rolling back only removes the diagnosis banners.

## Escalation
The runner image, kiro-cli version and shared key are managed in the AWS-Demo-Platform
repository; pinning or rebuilding the image, or rotating the key, is a change there, not here.

## Background
`--trust-tools=` (empty) used to be the no-tools mechanism. kiro-cli 2.11.1 still documents it
(`chat --help`: "trust no tools: '--trust-tools='") but parses the empty value as a custom
tool name, prints `WARNING: --trust-tools arg for custom tool  needs to be prepended with
@{MCPSERVERNAME}/`, and ignores it — so a cell could read files in its cwd. The only working
mechanism is an agent config with `"tools": []` passed via `--agent`, copied into each cell's
`$CELL_CWD/.kiro/agents/` (HOME=$CELL_CWD, so the global and workspace agent paths coincide).
The `--v3` drop is consistent with the AWS-Demo-Platform repository's ADR-011; it is unrelated
to this repo's own ADR-011 (dashboard deploy). `tests/unit/test-pr-review-panel.sh` pins the
current mechanism and both signatures above using stub binaries (no real model calls).
