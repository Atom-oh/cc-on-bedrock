# Terraform Module

## Role
Terraform HCL로 전체 인프라 배포. 4개 모듈.

## Key Files
- `main.tf` - Root module, 모듈 호출 및 연결
- `variables.tf` - 입력 변수 (CDK config와 동일)
- `outputs.tf` - 주요 리소스 ID/ARN 출력
- `providers.tf` - AWS provider (ap-northeast-2)
- `terraform.tfvars.example` - 예제 변수 값
- `modules/network/` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `modules/security/` - Cognito (Hosted UI), ACM, KMS, Secrets Manager, IAM
- `modules/ecs-devenv/` - ECS Cluster, NLB + Nginx Fargate, DynamoDB Routing Table, DLP SGs, Lambda (nginx-config-gen), EC2 DevEnv (Launch Template, per-user IAM)
- `modules/dashboard/` - Dashboard EC2 ASG, ALB, CloudFront

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
cd terraform && terraform init                 # Initialize
cd terraform && terraform validate             # Validate
cd terraform && terraform fmt -recursive       # Format
cd terraform && terraform plan                 # Preview changes
cd terraform && terraform apply                # Deploy
```

## Rules
- `terraform fmt -recursive` 후 커밋
- 모듈 간 의존성은 변수로 전달 (Terraform이 자동 의존성 그래프 구축)
- `terraform.tfvars.example`을 `terraform.tfvars`로 복사 후 값 수정하여 사용
- CDK와 동일한 인프라를 구현해야 함 — CDK에 새 리소스 추가 시 TF도 반영 필요
