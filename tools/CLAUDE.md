# Tools Module

## Role
End-user CLI helpers. The main artifact is `cc-bedrock-local.sh`, the Local Governance Mode user CLI (ADR-006).

## Key Files
- `cc-bedrock-local.sh` — Local Governance Mode CLI wrapper. It logs into Cognito, fetches 1h STS credentials from the dashboard (`/api/local/credentials`), and runs `claude` with `CLAUDE_CODE_USE_BEDROCK=1` or `codex` through the `amazon-bedrock-runtime` provider (ADR-014). It installs `credential_process = cc-bedrock-local.sh credential-process` into `~/.aws/config [profile cc-bedrock]`; the AWS SDK re-invokes it before each expiration, so sessions of any length survive the 1h role-chaining cap. Re-login is needed only when the 30-day Cognito refresh token expires. Legacy static-key `[cc-bedrock]` sections in `~/.aws/credentials` are removed on login/refresh/launch because they would shadow `credential_process`.
- `cc-bedrock-local.ps1` — Windows port (Windows PowerShell 5.1 / pwsh 7, no bash/python). Same config, state and managed keys as the bash CLI (parity enforced by `tests/unit/test-cc-bedrock-local-ps1.sh` when `pwsh` is present). Covers Claude Code CLI + the Claude Desktop Code tab (`settings.json`) and Codex CLI + the Codex app (`config.toml`). `credential_process` / `awsCredentialExport` call `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path with forward slashes> credential-process` with no double quotes (the Rust AWS SDK in Codex hands the line to `cmd.exe /C` as one `\"`-escaped argument, so quotes reach PowerShell literally and the credential load fails); a path containing whitespace uses `-EncodedCommand` instead. Extra opt-in `setup-desktop` / `unsetup-desktop` writes Claude Desktop third-party policy values under `HKCU\SOFTWARE\Policies\Claude` (Bedrock provider, region, profile, AWS CLI path, `inferenceModels`, and `coworkEgressAllowedHosts` = `["*"]` unless config `DESKTOP_EGRESS_HOSTS` lists hosts — unset, Chat/Cowork refuse every web fetch; Desktop has no native web search on Bedrock/mantle, that needs a `managedMcpServers` websearch entry); that key is often admin-only, so on a write failure it writes a `.reg` file, imports it through a UAC prompt (`reg.exe import` elevated as the same account) and reads the values back to report success, leaving the `.reg` file for the user or IT otherwise. Installed as `%USERPROFILE%\.local\lib\cc-bedrock\cc-bedrock-local.ps1`; only the `cc-bedrock-local.cmd` shim is in the PATH dir `%USERPROFILE%\.local\bin` (PowerShell resolves a bare name to a `.ps1` first and the default execution policy refuses it). No `claude`/`codex`/`run` wrappers. Keep the file pure ASCII: Windows PowerShell 5.1 reads BOM-less files in the ANSI code page. Installed by `/api/install/windows`, served by `/api/install/cli-ps1`.
- `cc-otel-code-metrics.sh` — retired. The custom emitter (session/git wrappers + 5-minute heartbeat) was superseded by native Claude Code OpenTelemetry (`claude_code.*` metrics + `tool_result` events), enabled via env in `ec2-clients.ts` `otelEnvUserData` (ADR-009). Kept for reference; no longer installed on DevEnvs.
- `prompts/`, `scripts/` — reserved, currently empty.

## Commands
```bash
# One-time setup per workstation (installs the CLI, runs setup + login)
curl -fsSL https://<dashboard_subdomain>.<domain>/api/install | bash

cc-bedrock-local setup               # plain claude/codex → Bedrock (~/.claude/settings.json, ~/.codex/config.toml)
                                     # while the user has a mantle grant: config.toml defaults to bedrock-mantle
                                     # (web search), runtime via runtime.config.toml (codex -p runtime),
                                     # mantle.config.toml (codex -p mantle) kept; reverts on revocation
cc-bedrock-local unsetup             # remove those managed keys
cc-bedrock-local login               # Cognito login, caches refresh token
cc-bedrock-local refresh             # silent refresh from the cached refresh token
cc-bedrock-local status              # remaining TTL + Deny/limit state
cc-bedrock-local claude [args]       # ensure session + exec claude
cc-bedrock-local codex [args]        # ensure session + exec codex on Bedrock
cc-bedrock-local set-model K=V       # sonnet | opus | haiku | subagent | pin | codex
cc-bedrock-local config              # print active config

# Windows (PowerShell or cmd)
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://<dashboard_subdomain>.<domain>/api/install/windows | iex"
cc-bedrock-local setup-desktop       # opt-in: Claude Desktop Cowork/Chat on Bedrock (needs AWS CLI v2)

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
