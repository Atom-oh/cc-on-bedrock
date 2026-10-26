# Tools Module

## Role
End-user CLI helpers. The main artifact is `cc-bedrock-local.sh`, the Local Governance Mode user CLI (ADR-006).

## Key Files
- `cc-bedrock-local.sh` — Local Governance Mode CLI wrapper. It logs into Cognito, fetches 1h STS credentials from the dashboard (`/api/local/credentials`), and runs `claude` with `CLAUDE_CODE_USE_BEDROCK=1` or `codex` through the `amazon-bedrock-runtime` provider (ADR-014). It installs `credential_process = cc-bedrock-local.sh credential-process` into `~/.aws/config [profile cc-bedrock]`; the AWS SDK re-invokes it before each expiration, so sessions of any length survive the 1h role-chaining cap. Re-login is needed only when the 30-day Cognito refresh token expires. Legacy static-key `[cc-bedrock]` sections in `~/.aws/credentials` are removed on login/refresh/launch because they would shadow `credential_process`.
- `cc-otel-code-metrics.sh` — retired. The custom emitter (session/git wrappers + 5-minute heartbeat) was superseded by native Claude Code OpenTelemetry (`claude_code.*` metrics + `tool_result` events), enabled via env in `ec2-clients.ts` `otelEnvUserData` (ADR-009). Kept for reference; no longer installed on DevEnvs.
- `prompts/`, `scripts/` — reserved, currently empty.

## Commands
```bash
# One-time setup per workstation (installs the CLI, runs setup + login)
curl -fsSL https://<dashboard_subdomain>.<domain>/api/install | bash

cc-bedrock-local setup               # plain claude/codex → Bedrock (~/.claude/settings.json, ~/.codex/config.toml)
cc-bedrock-local unsetup             # remove those managed keys
cc-bedrock-local login               # Cognito login, caches refresh token
cc-bedrock-local refresh             # silent refresh from the cached refresh token
cc-bedrock-local status              # remaining TTL + Deny/limit state
cc-bedrock-local claude [args]       # ensure session + exec claude
cc-bedrock-local codex [args]        # ensure session + exec codex on Bedrock
cc-bedrock-local set-model K=V       # sonnet | opus | haiku | subagent | pin | codex
cc-bedrock-local config              # print active config

bash -n tools/cc-bedrock-local.sh    # syntax check (also run by tests/run-all.sh)
```

The default `dashboard_subdomain` is `cconbedrock-dashboard`.

## Configuration
- Config `~/.config/cc-bedrock/config` and state `~/.config/cc-bedrock/state.json` (last credentials + limit status), both mode 600.
- AWS profile: `~/.aws/config [profile cc-bedrock]` using `credential_process`.
- Env overrides win: `CC_BEDROCK_DASHBOARD_URL`, `CC_BEDROCK_EMAIL`, `AWS_PROFILE_NAME`, `AWS_REGION`.

## Behavior to preserve
- The CLI logs into Cognito directly through the public CLI app client and sends the Cognito access token to `/api/local/credentials`.
- Refresh thresholds: `run`/`claude` pre-fetch at launch when TTL < 10 min. `credential-process` serves the cache while TTL > 5 min and silently re-issues otherwise. It never prompts; when the refresh token is dead it exits 1 with a re-login hint, since an SDK hook cannot be interactive.
- Date handling tries GNU `date -d`, then BSD `date -j -f`, then python3, so it works on Linux and macOS.
- Runtime dependencies are only `python3` and `curl`; the AWS CLI is not required.
- The `[cc-bedrock]` profile snippet in the response is rewritten to the configured `AWS_PROFILE_NAME` before it is written.

## Related
- ADR-006 (Local Mode, credential_process), ADR-008 (dollar budget × normalized token limit), ADR-014 (Codex)
- Dashboard: `shared/nextjs-app/src/app/local/page.tsx`, `src/app/api/local/credentials/route.ts`, `src/app/api/install/route.ts`
- Lambda: `lambda/sts-issuer.py`
