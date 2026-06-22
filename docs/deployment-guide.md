# Deployment Guide

CC on Bedrock is deployed from Terraform only.

## Prerequisites

- AWS credentials with permissions to create VPC, IAM, Cognito, DynamoDB, Lambda, ECS, EC2, CloudFront, WAF, Route 53, S3, ECR, and CloudWatch resources.
- Terraform 1.6 or newer.
- Node.js 20 or newer for the dashboard build.
- Docker with ARM64 build support for DevEnv and dashboard images.
- Route 53 hosted zone for the dashboard and DevEnv domains.
- Bedrock model access and Application Inference Profiles for the Claude models in use.

## Deploy

```bash
terraform -chdir=terraform init
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

Important outputs:

- `cognito_cli_public_client_id`
- `routing_table_name`
- `otel_collector_endpoint`
- `sts_issuer_function_url`
- `devenv_nlb_dns`

## Runtime Modes

- EC2 Mode: CloudFront -> NLB -> nginx on ECS Fargate -> per-user EC2 DevEnv.
- Local Mode: `cc-bedrock-local` -> Cognito public client -> Dashboard `/api/local/credentials` -> STS issuer.

EC2 and Local use aligned policy shape, permission boundary, tags, and inference-profile attribution. They do not share one literal IAM role.

## Storage

DevEnv instances use EBS GP3 root volumes. Stop/Start preserves user files, packages, code-server extensions, and local configuration.

## Local Mode

```bash
curl -fsSL https://dashboard.example.com/api/install | bash
cc
```

Local credentials use Cognito refresh tokens and AWS SDK `credential_process`. STS credentials remain one hour because AWS role chaining is capped at one hour, but active SDK clients can refresh credentials instead of ending the user workflow.

## Verify

```bash
bash scripts/08-verify-deployment.sh example.com
bash tests/integration/test-local-governance.sh
```

Run the fast local gate before changing infrastructure:

```bash
bash tests/run-all.sh
```

## Destroy

```bash
terraform -chdir=terraform destroy
```
