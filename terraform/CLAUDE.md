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
- `modules/ecs-devenv/` - ECS Cluster, Task Defs, EFS, NLB+Nginx, DynamoDB Routing, CloudFront
- `modules/dashboard/` - Dashboard EC2 ASG, ALB, CloudFront
- ※ Usage Tracking (DynamoDB, Lambda, EventBridge) 모듈 추가 필요

## Rules
- `terraform fmt -recursive` 후 커밋
- 모듈 간 의존성은 변수로 전달 (Terraform이 자동 의존성 그래프 구축)
- `terraform.tfvars.example`을 `terraform.tfvars`로 복사 후 값 수정하여 사용
