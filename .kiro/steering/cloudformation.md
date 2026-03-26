# CloudFormation Module

## Role
CloudFormation YAML로 전체 인프라 배포. 4개 템플릿 + Shell 배포 스크립트 (Usage Tracking 추가 필요).

## Key Files
- `01-network.yaml` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `02-security.yaml` - Cognito, ACM, KMS, Secrets Manager, IAM
- `04-ecs-devenv.yaml` - ECS Cluster, Task Defs, EFS, ALB, CloudFront
- `05-dashboard.yaml` - Dashboard EC2 ASG, ALB, CloudFront
- `03-litellm.yaml` - **deprecated** (Bedrock Direct 전환으로 제거 예정)
- `deploy.sh` - 순차 배포, 스택 출력값 자동 전달
- `destroy.sh` - 역순 삭제
- `params/default.json` - 기본 파라미터 값

## Rules
- `!ImportValue`로 cross-stack 참조
- `--capabilities CAPABILITY_NAMED_IAM` 자동 포함
- `--no-fail-on-empty-changeset`으로 idempotent 배포
