# CDK Module

## Role
AWS CDK v2 (TypeScript)로 전체 인프라 배포. 5개 스택.

## Key Files
- `bin/app.ts` - CDK app entry, 모든 스택 연결 및 의존성 설정
- `config/default.ts` - CcOnBedrockConfig 인터페이스 + 기본값
- `lib/01-network-stack.ts` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `lib/02-security-stack.ts` - Cognito, ACM, KMS, Secrets Manager, IAM
- `lib/03-litellm-stack.ts` - Internal ALB, ASG, RDS, Valkey, ECR
- `lib/04-ecs-devenv-stack.ts` - ECS Cluster, Task Defs, EFS, ALB, CloudFront
- `lib/05-dashboard-stack.ts` - Dashboard EC2 ASG, ALB, CloudFront

## Rules
- IAM Role은 사용하는 스택에서 생성 (cross-stack cyclic ref 방지)
- grantRead/grantPull 대신 broad ARN 패턴 사용
- CDK context로 파라미터 오버라이드: `cdk deploy -c vpcCidr=10.1.0.0/16`
