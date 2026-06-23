# CC on Bedrock

Governed multi-user development platform for Claude Code on Amazon Bedrock. The first-class implementation is Claude Code on Bedrock; Codex on Bedrock is a later extension. Kiro is installed as a default tool, but it uses IAM Identity Center subscription licensing and is not governed through Cognito or Bedrock API token controls.

## Architecture

- **IaC:** Terraform only.
- **EC2 Mode:** CloudFront -> NLB -> nginx on ECS Fargate -> per-user EC2 DevEnv.
- **Local Mode:** `cc-bedrock-local` -> Cognito public client -> Dashboard `/api/local/credentials` -> STS issuer.
- **Compute:** Per-user EC2 instances with Ubuntu or Amazon Linux 2023 support.
- **Storage:** EBS GP3 root volume per DevEnv.
- **IDE:** code-server on port `8080`; custom routes map path prefixes to additional user ports.
- **Usage:** Bedrock Application Inference Profiles + Bedrock Invocation Logs -> Lambda -> DynamoDB.
- **Limits:** Department and user budgets/limits attach or remove IAM deny policies through EventBridge/Lambda.
- **Observability:** EC2 code activity metrics are emitted every minute to the OTEL Collector.

## Key Paths

```text
terraform/          Terraform root and modules
lambda/             Lambda handlers packaged by Terraform
shared/nextjs-app/  Dashboard application
tools/              Local CLI and OTEL helper scripts
docker/nginx/       Shared nginx router image
tests/              Unit and integration tests
docs/               ADRs, runbooks, specs, plans
```

## Local Mode

Install the governed CLI:

```bash
curl -fsSL "$(terraform -chdir=terraform output -raw dashboard_url)/api/install" | bash
```

Then run:

```bash
cc
cc --status
cc --logout
```

`cc-bedrock-local` stores Cognito refresh tokens locally and wires AWS SDK `credential_process` into `~/.aws/config`. STS credentials remain one hour because AWS role chaining is capped at one hour, but active Claude Code sessions can refresh through the SDK credential process instead of being interrupted.

## Terraform

```bash
terraform -chdir=terraform init
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan
```

> **Local Governance-only mode is GATED — not yet wired.** The `governance_only`
> Terraform variable is a planned follow-up (see `terraform/CLAUDE.md` and `BASELINE.md` §2);
> until it lands, all modules deploy together. Do not pass `governance_only` yet.

Important outputs include:

- `cognito_cli_public_client_id`
- `routing_table_name`
- `otel_collector_endpoint`
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
