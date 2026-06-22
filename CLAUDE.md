# CC on Bedrock Project Guide

## Current Direction

Terraform is the only active IaC surface. Lambda handlers live in `lambda/` so Terraform can package them without depending on an IaC-specific source tree.

Claude Code on Bedrock is the first implementation target. Codex on Bedrock is a later extension. Kiro is installed by default, but Kiro uses IAM Identity Center subscription licensing and does not participate in Cognito/Bedrock API usage governance.

## Architecture

- EC2 Mode: CloudFront -> NLB -> nginx on ECS Fargate -> per-user EC2 DevEnv.
- Local Mode: `cc-bedrock-local` -> Cognito public client -> Dashboard `/api/local/credentials` -> STS issuer.
- code-server stays on port `8080`.
- DevEnv storage is EBS GP3.
- Usage and budgets are enforced from Bedrock Invocation Logs, Application Inference Profiles, DynamoDB, Lambda, and IAM deny policy updates.
- EC2 code activity metrics push to the OTEL Collector every 60 seconds.

## Key Paths

```text
terraform/          Terraform root and modules
lambda/             Lambda source
shared/nextjs-app/  Dashboard
tools/              CLI and operational scripts
docker/nginx/       Shared nginx router image
tests/              Test suites
docs/               ADRs, specs, runbooks, plans
```

## Commands

```bash
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform validate
bash -n tools/cc-bedrock-local.sh tools/cc-otel-code-metrics.sh
python3 -m pytest tests/unit/ scripts/__tests__/ -q
bash tests/run-all.sh
```

## Rules

- Do not add alternate deployment IaC paths.
- Do not place Lambda source under an IaC directory.
- Do not use one literal IAM role for both EC2 and Local mode. Share policy shape, permission boundaries, tags, and inference-profile attribution instead.
- Do not try to extend chained STS credentials beyond one hour. Use `credential_process` renewal.
- Keep Kiro out of Cognito and Bedrock token-limit enforcement.
- Keep port `8080` reserved for code-server; custom route ports must not use it.
