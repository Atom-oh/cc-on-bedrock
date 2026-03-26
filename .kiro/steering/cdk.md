# CDK Module

## Role
AWS CDK v2 (TypeScript)로 전체 인프라 배포. 5 active stacks + 1 retained (LiteLLM).

## Key Files
- `bin/app.ts` - CDK app entry, 스택 연결 및 의존성
- `config/default.ts` - CcOnBedrockConfig 인터페이스 + 기본값
- `lib/01-network-stack.ts` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `lib/02-security-stack.ts` - Cognito (Hosted UI), ACM, KMS, Secrets Manager, IAM
- `lib/03-usage-tracking-stack.ts` - DynamoDB, Lambda (EventBridge 트리거), EventBridge Rules
- `lib/03-litellm-stack.ts` - **Retained, not deployed** (삭제 전까지 보존)
- `lib/04-ecs-devenv-stack.ts` - ECS Cluster, Task Defs, EFS, ALB, CloudFront
- `lib/05-dashboard-stack.ts` - Dashboard EC2 ASG, ALB, CloudFront
- `lib/lambda/bedrock-usage-tracker.py` - Bedrock API 호출 추적 (EventBridge → DynamoDB)
- `lib/lambda/budget-check.py` - 예산 초과 확인 (5분 주기, IAM Deny Policy 동적 부착)

## Rules
- IAM Role은 사용하는 스택에서 생성 (cross-stack cyclic ref 방지)
- grantRead/grantPull 대신 broad ARN 패턴 사용
- CDK context로 파라미터 오버라이드: `cdk deploy -c vpcCidr=10.1.0.0/16`
