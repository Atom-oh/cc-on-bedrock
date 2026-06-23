# Tools Module

## Role
End-user CLI helpers and operational prompts. The most important artifact is `cc-bedrock-local.sh`, the **Local Governance Mode** user CLI (ADR-014).

## Key Files
- `cc-bedrock-local.sh` — Local Governance Mode CLI wrapper. Fetches 1h STS credentials from the Dashboard (`/api/local/credentials`) and exec's `claude` with `CLAUDE_CODE_USE_BEDROCK=1`. **ADR-029**: installs `credential_process = cc-bedrock-local.sh credential-process` into `~/.aws/config [profile cc-bedrock]` — the AWS SDK re-invokes the hook before each Expiration, so sessions of any length survive the 1h role-chaining cap (re-login only when the 30d Cognito refresh token dies). Legacy static-key `[cc-bedrock]` sections in `~/.aws/credentials` are removed on login/refresh/launch (they would shadow credential_process). ADR-014.
- `cc-otel-code-metrics.sh` — EC2 DevEnv code activity collector. Emits OTLP HTTP metrics for repo count, commits, LoC, and review markers; intended to run from a 60s systemd timer on EC2.
- `prompts/` — Reserved for shared LLM prompt templates (currently empty)
- `scripts/` — Reserved for additional shell helpers (currently empty)

## Commands
```bash
# One-time setup (per user workstation)
curl -fsSL https://cconbedrock-dashboard.<domain>/api/install | bash

# Operations
cc-bedrock-local login               # Cognito login, caches refresh token
cc-bedrock-local refresh             # silent refresh from cached Cognito refresh token
cc-bedrock-local status              # remaining TTL + Deny/limit state
cc-bedrock-local claude              # auto-refresh + exec claude
cc-bedrock-local config              # print active config
cc                                # shell function installed by /api/install

# Syntax check
bash -n tools/cc-bedrock-local.sh tools/cc-otel-code-metrics.sh
```

## Configuration
- File: `~/.config/cc-bedrock/config` (mode 600)
- State: `~/.config/cc-bedrock/state.json` (last credentials + limit status, mode 600)
- AWS profile written to: `~/.aws/config [profile cc-bedrock]` (credential_process, ADR-029); legacy static-key section in `~/.aws/credentials` is auto-removed
- Env overrides win: `CC_BEDROCK_DASHBOARD_URL`, `CC_BEDROCK_EMAIL`, `AWS_PROFILE_NAME`, `AWS_REGION`

## Rules
- The CLI logs into Cognito directly via the public CLI app client and sends the Cognito access token to `/api/local/credentials`.
- Refresh thresholds: `run`/`claude` pre-fetch at launch when TTL < 10 min; `credential-process` serves cache while TTL > 5 min, silently re-issues otherwise (never prompts — exits 1 with a re-login hint when the refresh token is dead)
- Cross-platform date handling: tries GNU `date -d`, BSD `date -j -f`, then python3 fallback
- Only `python3` and `curl` runtime dependencies — no AWS CLI required
- Profile snippet `[cc-bedrock]` in the response is rewritten to use the configured `AWS_PROFILE_NAME` before write

## Related
- ADR-014: Local Governance Mode (EC2-less)
- ADR-015: Dollar Budget × Normalized Token Limit Integration
- Dashboard: `shared/nextjs-app/src/app/local/page.tsx`, `src/app/api/local/credentials/route.ts`
- Lambda: `lambda/sts-issuer.py`
