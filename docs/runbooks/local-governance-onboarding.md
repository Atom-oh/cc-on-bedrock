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
cc
ccx
```

The first run prompts for Cognito email/password through the public client's
password-auth flow. The CLI stores a refresh-token cache locally and configures
AWS SDK `credential_process` in `~/.aws/config`. It does not depend on browser
OIDC or an eight-hour static credentials file. `cc` runs governed Claude Code;
`ccx` runs governed Codex with `amazon-bedrock-runtime`.

## Verify identity and renewal

```bash
cc --status
aws sts get-caller-identity --profile cc-bedrock
```

Expect the assumed role `cc-on-bedrock-local-user-{subdomain}` for that user.
The canonical data key is lowercased **email**, while IAM/resource suffixes use
**subdomain**. Neither is the Cognito UUID. Confirm the actual profile name if
the CLI configuration was customized.

STS role chaining caps the issued credentials at one hour. The SDK credential
process renews them as needed; CLI `refresh` silently uses a cached Cognito
refresh token, while `login` is the interactive recovery path. `cc --logout`
clears the local session. Never paste refresh tokens or issued credentials into
an issue or log.

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
