# Design — Governed Local CLI: auto-renewing credentials + multi-tool launchers

- **Date:** 2026-06-11
- **Status:** Draft (awaiting user approval)
- **Area:** Local Governance Mode client (ADR-014); governed model ceiling (ADR-021)
- **Related code:** `tools/cc-bedrock-local.sh`, `cdk/lib/lambda/sts-issuer.py`, `cdk/lib/lambda/role_factory.py`, `cdk/lib/02-security-stack.ts`

## Problem

In Local Governance Mode (ADR-014), the user runs Claude Code on their own machine against Bedrock under governed per-user STS credentials. Two pain points:

1. **Mid-session credential expiry.** STS credentials live 1 hour. The CLI wrapper (`cc-bedrock-local run -- claude`) only refreshes **at launch** (`tools/cc-bedrock-local.sh:289-317`); it is not a background renewer. A single Claude Code session longer than ~1h hits an expired token mid-work and Bedrock calls start failing until the wrapper is restarted.
2. **The 1h is a hard AWS limit, not a setting.** The issuer Lambda calls `sts.assume_role()` using its own execution role (`sts-issuer.py:63,113`) — role→role *chaining*, which AWS caps at 1h (`DurationSeconds > 3600` → `ValidationError`). "Set it back to 8h" is impossible in this architecture.

Additional requirement surfaced during design:

3. **Codex support.** The same governed credentials should launch the Codex CLI, not just Claude Code. Launch commands for the two tools must be **separate** (no `--claude/--codex` flag selector).
4. **Shorter command name.** `cc-bedrock-local` is too long.

## Goals

- A long-running Claude Code (or Codex) session never dies from credential expiry — credentials renew transparently, mid-session.
- Codex runs under the same governed Bedrock credentials as Claude Code.
- Separate, short launch commands per tool.
- **No weakening of the security posture** for the renewal fix (TTL stays 1h, role-chaining intact, per-user role + Deny enforcement intact).

## Non-goals

- Raising the raw STS TTL above 1h (rejected — would require a long-lived IAM-user issuer; unnecessary given the wrapper-only usage).
- A background refresh daemon (rejected — fragile; `credential_process` does this natively).
- Changing the server-side issuer/limit-enforcement architecture.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **`credential_process` AWS profile** is the credential engine. | The AWS SDK invokes it on demand and re-invokes near expiry — transparent mid-session renewal with zero security tradeoff. Native, not a daemon. |
| D2 | **Separate launcher binaries** via `$0`-basename dispatch: `ccb`, `ccb-claude`, `ccb-codex` (symlinks to one script). | User requirement: separate start commands, not a flag selector. One script to install/update. |
| D3 | Main command renamed **`ccb`** (cc-bedrock); keep `cc-bedrock-local` as a back-compat symlink. | Short, avoids the `cc` C-compiler clash. |
| D4 | **Widen the governed model ceiling** to permit OpenAI gpt models, scope `*openai.gpt-*` (family wildcard, mirroring the existing `*anthropic.claude-*`). Applied in **both** the permission boundary and the per-user role inline policy. | Codex uses `openai.gpt-5.5`; the boundary is the ceiling, so both must widen. Family wildcard matches ADR-021's Claude handling and survives version bumps. |

## Architecture

```
~/.aws/config
  [profile cc-bedrock]
    credential_process = ccb credential-process
    region = <governed region>

AWS SDK (Claude Code / Codex / aws cli, all under AWS_PROFILE=cc-bedrock)
   │  needs creds, or cached creds near expiry
   ▼
ccb credential-process
   │  1. ensure live Cognito token (silent refresh; else exit 1 "ccb login")
   │  2. POST {DASHBOARD_URL}/api/local/credentials  (Bearer Cognito access token)
   │  3. print AWS JSON v1 contract on stdout (logs → stderr)
   ▼
STS Issuer Lambda → AssumeRole (1h) → per-user role  (unchanged)
```

Single script, three entry points:
- **`ccb <verb>`** — admin: `login`, `logout`, `status`, `setup`, `config`, `credential-process` (internal), `help`.
- **`ccb-claude [args…]`** — `exec claude "$@"` with governed env.
- **`ccb-codex [args…]`** — `exec codex "$@"` with governed env.

## Components

### C1 — `credential-process` subcommand (contract-critical)
- Loads config, ensures a valid Cognito token: if the cached access token is usable, use it; else silent refresh via the cached refresh token; if that fails (refresh token expired), write `re-login required: ccb login` to **stderr** and **exit non-zero**.
- Calls `/api/local/credentials`, parses the STS credentials.
- Prints **only** the AWS credential-process JSON v1 object to stdout:
  ```json
  {"Version":1,"AccessKeyId":"…","SecretAccessKey":"…","SessionToken":"…","Expiration":"2026-06-11T10:00:00Z"}
  ```
- **Invariant:** stdout carries the JSON and nothing else; all human/diagnostic output goes to stderr; any failure is a non-zero exit so the SDK surfaces a clear error.

### C2 — `ccb setup`
- Idempotently writes/updates the `[profile cc-bedrock]` block in `~/.aws/config` with `credential_process` and `region`. Avoids hand-editing. Leaves other profiles untouched.

### C3 — `$0` dispatch + launchers
- The script inspects `basename "$0"`: `ccb-claude` → launcher(claude); `ccb-codex` → launcher(codex); otherwise verb dispatch.
- `ccb-claude`: set `AWS_PROFILE=<name>`, `AWS_REGION=<governed>`, Claude model env (existing `ANTHROPIC_MODEL` logic), then `exec claude "$@"`.
- `ccb-codex`: set `AWS_PROFILE=<name>`, `AWS_REGION=<governed>`, then `exec codex "$@"` (Codex reads `model_provider=amazon-bedrock` from its own `~/.codex/config.toml`).
- Both fail loudly if the target binary is not on `PATH`.
- No per-launch credential fetching — credentials come through the `credential_process` profile.

### C4 — IAM model-ceiling widening (D4)
Add OpenAI gpt patterns in **two** places (both currently Claude-only):

1. **Permission boundary** `cc-on-bedrock-task-boundary` — `cdk/lib/02-security-stack.ts:158-162`, the `bedrock:InvokeModel*`/`Converse*` statement resources.
2. **Per-user local role inline policy** — `cdk/lib/lambda/role_factory.py:33` `allowed_model_arns()`.

New resource ARNs added to each (alongside the Claude entries):
```
arn:aws:bedrock:*::foundation-model/*openai.gpt-*
arn:aws:bedrock:*:{ACCOUNT_ID}:inference-profile/*openai.gpt-*
```
(`application-inference-profile/*` is already wildcard in both, so it needs no change.)

> Note on the EC2-mode base policy (`02-security-stack.ts:136` `bedrockPolicy`): used by the dashboard/EC2 task roles, not the Local role. Out of scope unless we also want Codex governed on EC2 DevEnv — **not** in this change.

### C5 — Codex region/model note
Codex's `config.toml` sets `[model_providers.amazon-bedrock.aws] region = us-east-2`. The new ARNs are region-`*` for foundation models, so the grant is region-agnostic. If the governed inference profile is region-specific, the launcher may pin region via `-c model_providers.amazon-bedrock.aws.region=<governed>`. To verify during implementation; default is to leave Codex's own region and rely on the region-`*` foundation-model ARNs.

## Data flow (mid-session renewal)
`tool call → SDK has no/expiring creds → runs "ccb credential-process" → (silent refresh if needed) → /api/local/credentials → STS 1h creds → JSON to stdout → SDK caches until ~expiry → repeat`. The user never sees an expiry during a long session.

## Error handling
- credential-process: stdout = JSON only; stderr = diagnostics; non-zero exit on any failure. Refresh-token-expired → explicit "ccb login" message.
- Launchers: missing `claude`/`codex` binary → clear error, non-zero exit.
- `ccb setup`: refuse to clobber a non-cc-bedrock profile; only manages the `cc-bedrock` block.

## Security analysis
- **Renewal (D1–D3): no change in posture.** Still 1h STS tokens, still role-chaining, still per-user role + Deny enforcement. We only automate renewal.
- **Model ceiling (D4): a real widening.** The governed boundary now permits the OpenAI gpt family in addition to Claude. This extends ADR-021's "wildcard Claude family in the boundary" decision to a second vendor family. Documented via an **ADR-021 addendum**. Still bounded to `*openai.gpt-*` (no `bedrock:*`, no other services). The ADR-026 T6 CI check (`scripts/check-policyset-boundary.py`) does not gate Bedrock model ARNs, so it remains green.

## Migration / backward compatibility
- `cc-bedrock-local` kept as a symlink → `ccb`; existing docs/muscle memory keep working.
- The static `~/.aws/credentials [cc-bedrock]` write path can remain for `ccb status`/manual use, but the launchers and SDK use the `credential_process` profile. `ccb setup` migrates a user to the profile.
- Server side: `sts-issuer.py` / `/api/local/credentials` contract unchanged. Only `role_factory.py` (and the boundary) change, and only additively (new allowed ARNs) — existing Claude grants unaffected.

## Testing
- `bash -n` on the script (all entry points).
- credential-process: emits valid JSON-v1, zero stdout noise, correct `Expiration`; non-zero exit + stderr message when refresh fails (mocked endpoint / injected failure).
- `$0` dispatch: `ccb-claude`/`ccb-codex`/`ccb` route correctly.
- IAM: `scripts/check-policyset-boundary.py` still passes; a unit assertion that `allowed_model_arns()` includes both the Claude and the new `*openai.gpt-*` patterns; boundary synth contains the OpenAI ARNs.
- `cdk synth` succeeds with the widened boundary.

## File-by-file change list
| File | Change |
|------|--------|
| `tools/cc-bedrock-local.sh` | Add `credential-process` + `setup` subcommands; `$0`-dispatch for `ccb-claude`/`ccb-codex` launchers; keep existing verbs. |
| install/symlinks | `ccb`, `ccb-claude`, `ccb-codex` (+ `cc-bedrock-local` back-compat) → the script. |
| `cdk/lib/02-security-stack.ts` | Add `*openai.gpt-*` foundation-model + inference-profile ARNs to the `cc-on-bedrock-task-boundary` InvokeModel statement. |
| `cdk/lib/lambda/role_factory.py` | Add the same `*openai.gpt-*` ARNs to `allowed_model_arns()`. |
| `docs/decisions/ADR-014-*.md` | Addendum: credential_process auto-renew + `ccb`/`ccb-claude`/`ccb-codex` launcher model. |
| `docs/decisions/ADR-021-*.md` | Addendum: OpenAI gpt family added to the governed model ceiling. |
| `tools/CLAUDE.md` | Rewrite for `ccb`/launchers/credential_process; fixes stale "8h" + `CC_BEDROCK_TOKEN` text (audit M14). |
| `cdk/CLAUDE.md` | Note OpenAI in the boundary/role model ceiling. |

## Open risks
- **Codex ↔ Bedrock region/inference-profile**: gpt-5.5 may require a system inference profile in a specific region; verify the ARN patterns actually authorize Codex's calls during implementation (C5).
- **Codex auth precedence**: confirm Codex's amazon-bedrock provider honors `AWS_PROFILE` + `credential_process` (standard AWS chain) rather than a separate auth path.
