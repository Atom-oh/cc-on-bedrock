# CloudFormation Module

## Role
CloudFormation YAML로 전체 인프라 배포. 5개 템플릿 + Shell 배포 스크립트.

## Key Files
- `01-network.yaml` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `02-security.yaml` - Cognito, ACM, KMS, Secrets Manager, IAM
- `03-litellm.yaml` - Internal ALB, ASG, RDS, Valkey, ECR
- `04-ecs-devenv.yaml` - ECS Cluster, Task Defs, EFS, ALB, CloudFront
- `05-dashboard.yaml` - Dashboard EC2 ASG, ALB, CloudFront
- `deploy.sh` - 순차 배포 (01→05), 스택 출력값 자동 전달
- `destroy.sh` - 역순 삭제 (05→01)
- `params/default.json` - 기본 파라미터 값

## Rules
- `!ImportValue`로 cross-stack 참조
- `deploy.sh`로 배포 시 `--capabilities CAPABILITY_NAMED_IAM` 자동 포함
- `--no-fail-on-empty-changeset`으로 idempotent 배포
