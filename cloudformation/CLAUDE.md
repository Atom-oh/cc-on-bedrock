# CloudFormation Module

## Role
CloudFormation YAML로 전체 인프라 배포. 4개 템플릿 + Shell 배포 스크립트.

## Key Files
- `01-network.yaml` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `02-security.yaml` - Cognito (Hosted UI), ACM, KMS, Secrets Manager, IAM
- `04-ecs-devenv.yaml` - ECS Cluster, NLB + Nginx, DynamoDB Routing Table
- `05-dashboard.yaml` - Dashboard EC2 ASG, ALB, CloudFront

## Drift vs CDK (parity gaps)
- ※ 03-Usage Tracking (DynamoDB **Streams**, Lambda, EventBridge) 템플릿 추가 필요
- ※ 07-EC2 DevEnv (Launch Template, per-user IAM) 템플릿 추가 필요
- ※ 08-Local Governance (ADR-014) — STS Issuer, token-limit-enforcer, limit-reset, `cc-on-bedrock-limits` 템플릿 추가 필요
- ※ ADR-016 CloudFront split — `05-dashboard.yaml`은 단일 CloudFront. CDK는 Dashboard CF + DevEnv CF로 분리되어 있어 `04-ecs-devenv.yaml`에 DevEnv CF + Route 53 `*.dev` record 이관 필요
- ※ `governanceOnly` 동등 파라미터 (Stack 04/07 skip) 미구현
- `deploy.sh` - 순차 배포 (01→05), 스택 출력값 자동 전달
- `destroy.sh` - 역순 삭제 (05→01)
- `params/default.json` - 기본 파라미터 값

## Commands
```bash
cd cloudformation && bash deploy.sh            # 순차 배포 (01→05)
cd cloudformation && bash destroy.sh           # 역순 삭제 (05→01)
```

## Rules
- `!ImportValue`로 cross-stack 참조
- `deploy.sh`로 배포 시 `--capabilities CAPABILITY_NAMED_IAM` 자동 포함
- `--no-fail-on-empty-changeset`으로 idempotent 배포
- CDK 기준으로 누락된 스택(Usage Tracking, EC2 DevEnv, Local Governance)은 추가 구현 필요
- ADR-016 CF split 적용 시 인증서 파라미터를 두 개(`DashboardCertArn`, `DevenvCertArn`)로 분리
