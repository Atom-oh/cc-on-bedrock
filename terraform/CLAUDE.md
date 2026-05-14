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

## Drift vs CDK (parity gaps)
- ※ Usage Tracking (DynamoDB **Streams**, Lambda, EventBridge) 모듈 — CDK Stack 03 미반영
- ※ Local Governance (ADR-014) — STS Issuer, token-limit-enforcer, limit-reset, `cc-on-bedrock-limits` table 미반영
- ※ ADR-016 CloudFront split 미반영 — 현재 `modules/dashboard/`가 단일 CloudFront. CDK는 Dashboard CF (Stack 05) + DevEnv CF (Stack 04)로 분리되어 있음. `*.dev.<domain>` 인증서는 us-east-1 ACM 별도 필요
- ※ `governanceOnly` 플래그 동등 변수 미구현

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
