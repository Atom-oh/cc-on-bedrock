# Local Governance Onboarding and Operations

Related: [ADR-006](../decisions/ADR-006-shared-credentials.md),
[ADR-008](../decisions/ADR-008-budget-enforcement.md),
[CLI instructions](../../tools/CLAUDE.md).

## Invite and install

1. In Admin → Users, create an account with email, department and project. Use
   Local mode when the user does not need an EC2 DevEnv.
2. The user signs in at dashboard `/login` with the invitation's temporary
   password and completes the set-new-password form. **Forgot password?**
   re-sends an invitation for a pending account; confirmed accounts receive an
   emailed reset code. Invitation validity follows the configured Cognito policy.
3. Set departmental/user USD budgets and normalized-token limits through the
   dashboard. Read weights from `lambda/token-limit-enforcer.py` and deployed
   overrides; do not reuse weights or price claims from a retired model version.
4. Install from the deployed dashboard:

```bash
DASHBOARD_URL="$(terraform -chdir=terraform output -raw dashboard_url)"
curl -fsSL "$DASHBOARD_URL/api/install" | bash
claude
codex
```

Accept the installer's setup/login prompt. If declined or no terminal is
available, run `cc-bedrock-local setup && cc-bedrock-local login` before starting
the tools. The installer does not install Claude Code or Codex; install missing
clients separately and ensure the helper is on PATH.

Login uses Cognito email/password through the public client. Setup writes
Claude's Bedrock environment and `awsCredentialExport` in
`~/.claude/settings.json`, Codex's `amazon-bedrock-runtime` provider/profile
in `~/.codex/config.toml`, and AWS SDK `credential_process` in `~/.aws/config`.
The helper caches a refresh token locally. Neither browser OIDC nor an
eight-hour static credentials file is required. Old managed `cc`/`ccx` shell
functions are removed from shell configuration; open a new shell to discard
functions already loaded.

### Windows PCs (Claude Desktop, Codex app)

From PowerShell or cmd (no admin rights, WSL, bash or Python needed):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://<dashboard>/api/install/windows | iex"
```

The installer drops `tools/cc-bedrock-local.ps1` into
`%USERPROFILE%\.local\lib\cc-bedrock` and a `cc-bedrock-local.cmd` shim into
`%USERPROFILE%\.local\bin` (added to the user PATH; only the shim is on PATH, since
PowerShell would pick a `.ps1` there first and the default execution policy refuses
it), removes a `.ps1` an older install left in the bin dir, resets
`%USERPROFILE%\.config\cc-bedrock` to an owner-only ACL (the install stops if
that fails), then runs `setup` and
`login`. The PowerShell CLI writes the same keys as the bash CLI, so:

- Claude Code CLI and the Claude Desktop **Code** tab read
  `%USERPROFILE%\.claude\settings.json` (Bedrock env + `awsCredentialExport`).
- Codex CLI and the **Codex app** read `%USERPROFILE%\.codex\config.toml`
  (`amazon-bedrock-runtime` on profile `cc-bedrock`). For a user with a mantle
  grant (unlimited cost), the default is bedrock-mantle with web search instead,
  which is not counted in usage or budget (ADR-014 §9 amendment 2026-11-03). The
  metered runtime path is then `codex -p runtime`, which only the CLI can use,
  since the app has no profile selection. If the user's config already defines
  its own `amazon-bedrock` provider, runtime stays the default. `setup` and
  `status` print the provider that was actually applied. Native Windows gets no
  Codex read-deny permission profile, because the Windows sandbox cannot enforce
  one.
- `~/.aws/config` gets `credential_process = powershell.exe -NoProfile
  -NonInteractive -ExecutionPolicy Bypass -File <path> credential-process`, with
  no double quotes, because Codex hands the line to `cmd.exe /C`. If the path
  contains whitespace, `-EncodedCommand` is used instead.

Restart Claude Desktop and the Codex app after setup. Claude Desktop
**Cowork/Chat** stays on claude.ai sign-in unless the user opts in with
`cc-bedrock-local setup-desktop` (the installer asks, default No). That writes
the third-party policy `HKCU\SOFTWARE\Policies\Claude` (`inferenceProvider=bedrock`,
`inferenceBedrockProfile=cc-bedrock`, region, `inferenceModels`,
`coworkEgressAllowedHosts`). Claude Desktop reads the named profile through AWS
CLI v2, which must be installed. Web fetch from Chat/Cowork is allowed for every
host by default. To narrow it, set `DESKTOP_EGRESS_HOSTS=host1,*.example.com`
in `%USERPROFILE%\.config\cc-bedrock\config`; `none` blocks every fetch.
Re-run `setup-desktop` after changing it (ADR-006 amendment 2026-11-03). If the
policy key is not writable, the CLI writes
`%USERPROFILE%\.config\cc-bedrock\claude-desktop-bedrock.reg` and imports it
through a UAC prompt. If the user declines the prompt, the file is left for IT.
A machine policy under `HKLM` overrides these values, and the CLI warns when one
exists. `unsetup-desktop` removes the values.
The `credential_process` path through Claude Desktop's AWS CLI lookup is not
documented by Anthropic; verify it on a pilot PC before rolling it out.

## Verify identity and renewal

```bash
cc-bedrock-local status
aws sts get-caller-identity --profile cc-bedrock
```

`status` reads the cached session/last-issued limit state; it does not query
current limits. Use the dashboard and governance diagnostics for current denies.

Expect the assumed role `cc-on-bedrock-local-user-{subdomain}` for that user.
The canonical data key is lowercased **email**, while IAM/resource suffixes use
**subdomain**. Neither is the Cognito UUID. Confirm the actual profile name if
the CLI configuration was customized.

STS role chaining caps the issued credentials at one hour. The SDK credential
process renews them as needed; CLI `refresh` silently uses a cached Cognito
refresh token, while `login` is the interactive recovery path.
`cc-bedrock-local logout` clears the cached session. `unsetup` removes managed
client keys but does not clear the cache, remove the AWS profile or revoke
issued sessions. It does not restore overwritten pre-setup settings; inspect
the first-edit `.cc-bedrock.bak` backup when restoring them.
Never paste refresh tokens or issued credentials into an issue or log.

Unset an inherited `AWS_BEARER_TOKEN_BEDROCK` before validating governed role
attribution: it can override the configured profile. If Codex already has custom
sandbox settings, setup preserves them with a warning; apply the credential-cache
directory deny manually as instructed by that warning.

A real invocation should later appear in Dashboard → usage/local views. Metering
is asynchronous; inspect the invocation-log tracker when records remain absent.
Codex Responses records are attributed by role, because application inference
profiles are not supported by that API.

## Diagnose a limit block

USD budgets and normalized-token limits are independent. USD daily/weekly/monthly
windows use UTC; token-limit windows use KST. Any applicable user/department cap
can block a request. A new credential session does not remove an IAM deny.

Use Admin → Budgets and Admin → Limits first. For a read-only inspection, use the
verified email/subdomain from the user record and the Terraform table output:

```bash
export AWS_REGION="<deployment-region>"
EMAIL="<canonical-lowercase-email>"
SUBDOMAIN="<verified-user-subdomain>"
LIMITS_TABLE="$(terraform -chdir=terraform output -raw local_governance_limits_table_name)"
ROLE_NAME="cc-on-bedrock-local-user-${SUBDOMAIN}"
aws iam list-role-policies --role-name "$ROLE_NAME"
KEY_JSON="$(jq -nc --arg pk "USER#$EMAIL" '{PK:{S:$pk},SK:{S:"DENY#active"}}')"
aws dynamodb get-item --region "$AWS_REGION" \
  --table-name "$LIMITS_TABLE" --key "$KEY_JSON"
VALUES_JSON="$(jq -nc --arg pk "USER#$EMAIL" '{":pk":{S:$pk},":sk":{S:"COUNTER#"}}')"
aws dynamodb query --region "$AWS_REGION" --table-name "$LIMITS_TABLE" \
  --key-condition-expression 'PK = :pk AND begins_with(SK, :sk)' \
  --expression-attribute-values "$VALUES_JSON"
```

The normalized-token policy is `cc-bedrock-local-token-deny`. Dollar-budget denies
have separate policy names and reset conditions; inspect both. Verify role-owner
email/subdomain tags before changing a role, especially after subdomain reuse.

For expected exhaustion, explain the recorded reset period. To change a limit,
update the intended user/department cap in the dashboard and use its supported
reset action. The reset endpoint preserves `DENY#active` if detachment fails; a
manual row deletion can hide an attached deny and must not be the default fix.
A token reset does not override an independently exhausted dollar budget.

## Credential incident and offboarding

Disable the affected Cognito account through supported administration to prevent
new Cognito login/refresh, then investigate the per-user role, CloudTrail audit
and invocation records. Existing NextAuth sessions are not automatically revoked:
the session branch of `/api/local/credentials` does not recheck Cognito's enabled
state and can still request STS credentials. Account disable alone does not
contain every issuance path. Apply and retain the incident role-deny/revocation
response until existing sessions and all issuance paths are contained, rather
than removing it solely when the first STS session expires. Logout on one client
does not revoke every dashboard or STS session.

For offboarding, use the supported user-management flow and verify downstream
IAM cleanup. A bare `delete-role` fails while policies or instance-profile
attachments remain. Preserve usage/audit history according to the retention
policy. The Cognito shim is wired, but its downstream provisioner, EventBridge
rule and DLQ are absent from current Terraform; see [ADR-010](../decisions/ADR-010-provisioning.md)
and [Terraform instructions](../../terraform/CLAUDE.md) rather than assuming
background cleanup is deployed.

## Troubleshooting

- **Usage absent:** inspect `bedrock-usage-tracker` logs and user role tags;
  metering uses invocation records, not account-wide CloudWatch token metrics.
- **Credential endpoint rejected:** check the public client's Cognito access
  token/session, account enabled state and current CLI configuration.
- **STS first-use failure:** inspect issuer IAM permission, boundary and role
  propagation. The issuer uses lazy role creation and retries; never switch to
  shared admin credentials as a workaround.
- **Block below the expected user limit:** inspect department caps, per-model
  normalization overrides, both enforcement axes and the recorded reset window.
