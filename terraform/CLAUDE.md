# Terraform Module

## Role

Terraform HCL is the canonical IaC for this repository.

## Key Files

- `main.tf` - Root module wiring.
- `variables.tf` - Root variables.
- `outputs.tf` - Deployment outputs consumed by the dashboard and operators.
- `providers.tf` - AWS providers, including `us-east-1` alias for CloudFront-scope WAF.
- `modules/network/` - VPC, subnets, NAT, endpoints, Route 53.
- `modules/security/` - Cognito, ACM, KMS, Secrets Manager, IAM, permission boundary.
- `modules/ecs-devenv/` - Shared Nginx router, NLB, routing table, config Lambda, OTEL Collector.
- `modules/ec2-devenv/` - Per-user EC2 DevEnv launch template, EBS GP3, DLP security groups.
- `modules/usage-tracking/` - Bedrock Invocation Logs, usage aggregation, budget checks.
- `modules/local-governance/` - STS issuer, token-limit enforcer, limit reset.
- `modules/dashboard/` - Dashboard hosting.
- `modules/waf/` - CloudFront-scope WAF.

## Commands

```bash
terraform -chdir=terraform init
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

## Rules

- Do not add alternate deployment IaC equivalents.
- Lambda packages must read from `../lambda` through the root `local.lambda_src_dir`.
- Keep code-server on `8080`; nginx may route additional validated custom ports.
- Keep EC2 and Local roles distinct, but aligned by shared policy boundary, tags, and inference-profile attribution.
- Keep OTEL Collector output available through `otel_collector_endpoint`.
