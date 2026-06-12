# Tools Module

## Role
End-user CLI helpers and operational prompts. The most important artifact is `cc-bedrock-local.sh`, the **Local Governance Mode** user CLI (ADR-014).

## Key Files
- `cc-bedrock-local.sh` — Local Governance Mode CLI wrapper. Fetches 1h STS credentials from the Dashboard (`/api/local/credentials`) and exec's `claude` with `CLAUDE_CODE_USE_BEDROCK=1`. **ADR-029**: installs `credential_process = cc-bedrock-local.sh credential-process` into `~/.aws/config [profile cc-bedrock]` — the AWS SDK re-invokes the hook before each Expiration, so sessions of any length survive the 1h role-chaining cap (re-login only when the 30d Cognito refresh token dies). Legacy static-key `[cc-bedrock]` sections in `~/.aws/credentials` are removed on login/refresh/launch (they would shadow credential_process). ADR-014.
- `prompts/` — Reserved for shared LLM prompt templates (currently empty)
- `scripts/` — Reserved for additional shell helpers (currently empty)

## Commands
```bash
# One-time setup (per user workstation)
mkdir -p ~/.config/cc-bedrock
cat > ~/.config/cc-bedrock/config <<'EOF'
DASHBOARD_URL=https://cconbedrock-dashboard.<domain>
CC_BEDROCK_TOKEN=<paste from Dashboard /local page>
AWS_PROFILE_NAME=cc-bedrock
AWS_REGION=ap-northeast-2
EOF

# Operations
cc-bedrock-local refresh             # fetch fresh 1h STS credentials
cc-bedrock-local status              # remaining TTL + Deny/limit state
cc-bedrock-local run -- claude       # auto-refresh + exec claude
cc-bedrock-local config              # print active config

# Syntax check
bash -n tools/cc-bedrock-local.sh
```

## Configuration
- File: `~/.config/cc-bedrock/config` (mode 600)
- State: `~/.config/cc-bedrock/state.json` (last credentials + limit status, mode 600)
- AWS profile written to: `~/.aws/config [profile cc-bedrock]` (credential_process, ADR-029); legacy static-key section in `~/.aws/credentials` is auto-removed
- Env overrides win: `CC_BEDROCK_DASHBOARD_URL`, `CC_BEDROCK_TOKEN`, `AWS_PROFILE_NAME`, `AWS_REGION`

## Rules
- Bearer token (`CC_BEDROCK_TOKEN`) is issued by the Dashboard `/local` page; the CLI never logs into Cognito directly
- Refresh thresholds: `run`/`claude` pre-fetch at launch when TTL < 10 min; `credential-process` serves cache while TTL > 5 min, silently re-issues otherwise (never prompts — exits 1 with a re-login hint when the refresh token is dead)
- Cross-platform date handling: tries GNU `date -d`, BSD `date -j -f`, then python3 fallback
- Only `python3` and `curl` runtime dependencies — no AWS CLI required
- Profile snippet `[cc-bedrock]` in the response is rewritten to use the configured `AWS_PROFILE_NAME` before write

## Related
- ADR-014: Local Governance Mode (EC2-less)
- ADR-015: Dollar Budget × Normalized Token Limit Integration
- Dashboard: `shared/nextjs-app/src/app/local/page.tsx`, `src/app/api/local/credentials/route.ts`
- Lambda: `cdk/lib/lambda/sts-issuer.py`
