# Terraform Module

## Role
Terraform HCL로 전체 인프라 배포. 4개 모듈 (Usage Tracking 모듈 추가 필요).

## Key Files
- `main.tf` - Root module, 모듈 호출 및 연결
- `variables.tf` / `outputs.tf` - 입력 변수, 출력값
- `providers.tf` - AWS provider (ap-northeast-2)
- `modules/network/` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `modules/security/` - Cognito, ACM, KMS, Secrets Manager, IAM
- `modules/ecs-devenv/` - ECS Cluster, Task Defs, EFS, ALB, CloudFront
- `modules/dashboard/` - Dashboard EC2 ASG, ALB, CloudFront
- `modules/litellm/` - **deprecated** (Bedrock Direct 전환으로 제거 예정)

## Rules
- `terraform fmt -recursive` 후 커밋
- 모듈 간 의존성은 변수로 전달
- `terraform.tfvars.example`을 `terraform.tfvars`로 복사 후 사용
