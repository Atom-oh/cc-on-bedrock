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

## Status (post-ADR-033 — Terraform is the sole IaC)
- ✅ **All 8 modules wired into root `main.tf`** (network, security, ecs-devenv, dashboard, usage-tracking, local-governance, waf, ec2-devenv).
- ✅ **task permission boundary `cc-on-bedrock-task-boundary` is now created in TF** (`modules/security`, `aws_iam_policy.task_permission_boundary`) and wired to ec2-devenv/local-governance via `task_permission_boundary_arn`. **[ADR-034](../docs/decisions/ADR-034-permission-boundary-in-terraform.md) supersedes ADR-030 §T3's "boundary is CDK-only"** stance (CDK deleted by ADR-033 → boundary authored in `modules/security`). NOTE: the ported policy is the ADR-026 ceiling — **porting ADR-030's boundary-X DenyEscalation floor refinement to the TF boundary is a follow-up**.
- ✅ OTel pipeline, nginx-config-gen + routing table, cognito-provisioner-trigger ported.
- ⚠️ **Remaining parity gaps (follow-up)**:
  - **Dashboard real-app deploy** — `modules/dashboard` user_data is a placeholder stub, not the real Next.js container.
  - ADR-022 `UserRoleProvisioner` Lambda + EventBridge `cc-on-bedrock-cognito-user-created` rule + DLQ.
  - Route 53 Resolver **DNS Firewall** (DLP DNS layer).
  - ADR-016 CloudFront split — DevEnv CF (`*.dev.<domain>`, us-east-1 cert) separate from Dashboard CF.
  - `modules/ecs-devenv/` 중복 DLP SG 세트 (deprecated ECS 경로) 정리.
  - `governanceOnly` 플래그 동등 변수.

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
