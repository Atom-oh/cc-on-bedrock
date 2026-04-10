# CloudFormation Module

## Role
CloudFormation YAML로 전체 인프라 배포. 4개 템플릿 + Shell 배포 스크립트.

## Key Files
- `01-network.yaml` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `02-security.yaml` - Cognito (Hosted UI), ACM, KMS, Secrets Manager, IAM
- `04-ecs-devenv.yaml` - ECS Cluster, Task Defs, EFS, NLB+Nginx, DynamoDB Routing, CloudFront
- `05-dashboard.yaml` - Dashboard EC2 ASG, ALB, CloudFront
- ※ Usage Tracking (DynamoDB, Lambda, EventBridge) 템플릿 추가 필요
- `deploy.sh` - 순차 배포 (01→05), 스택 출력값 자동 전달
- `destroy.sh` - 역순 삭제 (05→01)
- `params/default.json` - 기본 파라미터 값

## Rules
- `!ImportValue`로 cross-stack 참조
- `deploy.sh`로 배포 시 `--capabilities CAPABILITY_NAMED_IAM` 자동 포함
- `--no-fail-on-empty-changeset`으로 idempotent 배포
