# CC on Bedrock

Governed multi-user development platform for Claude Code and OpenAI Codex CLI on Amazon Bedrock. Kiro is installed as a default tool, but it uses IAM Identity Center subscription licensing and is not governed through Cognito or Bedrock API token controls.

## Architecture

- **IaC:** Terraform only.
- **Dashboard:** CloudFront VPC origin -> internal ALB -> EC2 Auto Scaling group running the Next.js container.
- **EC2 Mode (optional):** CloudFront VPC origin -> internal NLB -> nginx on ECS Fargate -> per-user EC2 DevEnv.
- **Local Mode:** `cc-bedrock-local` -> Cognito public client -> Dashboard `/api/local/credentials` -> STS issuer.
- **Compute:** Per-user EC2 instances with Ubuntu or Amazon Linux 2023 support.
- **Storage:** Separate OS root and persistent GP3 data volumes; `/home/coder` data survives termination and is reattached by subdomain tags.
- **IDE:** code-server on port `8080`; custom routes map path prefixes to additional user ports.
- **Usage:** Bedrock Invocation Logs -> Lambda -> DynamoDB; Claude uses application inference profiles, while Codex Responses usage is attributed through per-user IAM roles.
- **Limits:** Department and user budgets/limits attach or remove IAM deny policies through EventBridge/Lambda.
- **Observability:** Native Claude Code OpenTelemetry metrics and scrubbed tool events -> collector -> S3 -> Lambda productivity rollup.

![CC-on-Bedrock deployment profiles and governance flows](img/cconbedrock_arch.png)

Read the [decision baseline](docs/decisions/BASELINE.md) and
[architecture](docs/architecture.md) for current contracts and implementation gaps.

## Key Paths

```text
terraform/          Terraform root and 8 modules
lambda/             Lambda handlers packaged by Terraform
shared/nextjs-app/  Dashboard application
tools/              Local CLI (cc-bedrock-local.sh) and OTEL helper scripts
docker/             DevEnv (AMI bake), dashboard, nginx and OTEL collector images
scripts/            Prerequisite checks, ECR/AMI/image builds, verification, PR-review tooling
agent/              AgentCore Runtime AI assistant
tests/              Fast gate, unit, integration and container tests
docs/               Architecture, ADRs, runbooks, deployment guide
```

## Local Mode

Install the governed CLI:

```bash
curl -fsSL "$(terraform -chdir=terraform output -raw dashboard_url)/api/install" | bash
```

Accept the installer's setup/login prompt, then run the tools directly.
If setup was skipped or no terminal was available, run
`cc-bedrock-local setup && cc-bedrock-local login` first. Install Claude Code
and Codex separately if missing; this installer configures their credentials.

```bash
claude                      # Claude Code on Bedrock
codex                       # OpenAI Codex on Bedrock
cc-bedrock-local status     # cached session and last-issued limit state
cc-bedrock-local unsetup    # remove managed client keys; does not log out
```

`setup` writes the Bedrock env and `awsCredentialExport` into `~/.claude/settings.json` and the `amazon-bedrock-runtime` provider into `~/.codex/config.toml`. `cc-bedrock-local` stores Cognito refresh tokens locally and wires AWS SDK `credential_process` into `~/.aws/config`. STS credentials remain one hour because AWS role chaining is capped at one hour, but active Claude Code sessions can refresh through the SDK credential process instead of being interrupted.

## Terraform

```bash
terraform -chdir=terraform init \
  -backend-config="bucket=${TF_STATE_BUCKET:?}" \
  -backend-config="key=cc-on-bedrock/terraform.tfstate" \
  -backend-config="region=${AWS_REGION:?}" \
  -backend-config="encrypt=true" -backend-config="use_lockfile=true"
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan
```

Set `TF_STATE_BUCKET` and `AWS_REGION` for your deployment. Terraform requires
at least 1.7; the S3 lockfile example requires 1.10 or later. Supply an existing
VPC, subnet IDs, shared Route 53 zone and immutable dashboard image tag in tfvars.
Follow the [deployment guide](docs/deployment-guide.md) for bootstrap ordering.

> **Deployment profiles.** `deployment_mode = "governance"` (default when unset) deploys the admin
> dashboard and the local installer only: users run Claude Code / Codex on their own PC with
> Cognito-issued STS credentials, and no EC2 DevEnv is created. Set
> `deployment_mode = "devenv"` to add per-user EC2 DevEnvs. The deprecated `governance_only`
> bool still works and overrides `deployment_mode` when set.

> **Upgrading an existing stack.** Older tfvars that set neither `deployment_mode` nor `governance_only` used to deploy DevEnvs. Set `deployment_mode = "devenv"` before upgrading to retain them. If DevEnv security groups exist and the mode is unset, `terraform plan` fails instead of destroying them. Explicitly changing an existing deployment to governance removes its DevEnv infrastructure.

Important outputs include:

- `cognito_cli_public_client_id`
- `routing_table_name`
- `otel_rollup_collector_endpoint`
- `sts_issuer_function_url`
- `devenv_nlb_dns`
- `dns_firewall_rule_group_id`

## Tests

```bash
bash -n tools/cc-bedrock-local.sh
bash -n tools/cc-otel-code-metrics.sh
python3 -m pytest tests/unit/ scripts/__tests__/ -q
bash tests/run-all.sh
```

`tests/run-all.sh` runs the fast local gate. AWS integration tests under `tests/integration/` require a deployed environment and real credentials.

Operational procedures: [local onboarding](docs/runbooks/local-governance-onboarding.md),
[instance recovery](docs/runbooks/instance-recovery.md) and
[destroy/redeploy](docs/runbooks/full-teardown-redeploy.md).
