# CDK Module

## Role
AWS CDK v2 (TypeScript)로 전체 인프라 배포. 8 stacks. `--context governanceOnly=true`로 EC2 DevEnv 스택을 skip하고 Local Governance Mode(ADR-014)만 배포 가능.

## Key Files
- `bin/app.ts` - CDK app entry, 모든 스택 연결 및 의존성 설정
- `config/default.ts` - CcOnBedrockConfig 인터페이스 + 기본값

### Stacks
- `lib/01-network-stack.ts` - VPC, Subnets, NAT, VPC Endpoints, Route 53
- `lib/02-security-stack.ts` - Cognito (Hosted UI domain 포함), ACM, KMS, Secrets Manager, IAM
- `lib/03-usage-tracking-stack.ts` - DynamoDB (사용량 저장), Lambda (EventBridge 트리거), EventBridge Rules
- `lib/04-ecs-devenv-stack.ts` - ECS Cluster, NLB+Nginx, DynamoDB Routing (CF 제거 → Stack 05로 통합, ADR-013)
- `lib/05-dashboard-stack.ts` - Dashboard ECS Ec2Service, ALB, Unified CloudFront (Dashboard + DevEnv, ADR-013), Lambda@Edge (session-validator, origin-router)
- `lib/06-waf-stack.ts` - WAF WebACL (CloudFront, ALB)
- `lib/07-ec2-devenv-stack.ts` - EC2-per-user DevEnv: Launch Template, DLP SG(open/restricted/locked), IAM Role, Instance Profile, DynamoDB(cc-user-instances). `governanceOnly=true`일 때 skip.
- `lib/08-local-governance-stack.ts` - Local Governance Mode (ADR-014): STS Issuer Lambda + Function URL, per-user IAM role factory(MaxSessionDuration=12h), Application Inference Profile per dept, `cc-on-bedrock-limits` DynamoDB, token-limit-enforcer (usage table Stream consumer), limit-reset (EventBridge cron 일/주/월)

### Lambdas
- `lib/lambda/bedrock-usage-tracker.py` - Bedrock API 호출 추적 (Invocation Logging → DynamoDB). usage 테이블에 Streams 활성 (token-limit-enforcer 트리거)
- `lib/lambda/budget-check.py` - 예산/토큰한도 초과 확인 (5분 주기, IAM Deny Policy 동적 부착). Local Governance Mode의 backup path
- `lib/lambda/sts-issuer.py` - Cognito ID 토큰 검증 → sts:AssumeRole 8h → 자격증명 반환 (Local Governance, ADR-014)
- `lib/lambda/token-limit-enforcer.py` - usage 테이블 Stream consumer, normalized token 합산, 한도 초과 시 user role에 Deny policy 부착 (Local Governance, ADR-014)
- `lib/lambda/limit-reset.py` - EventBridge cron(일/주/월), 카운터 리셋 + Deny policy detach (Local Governance, ADR-014)
- `lib/lambda/nginx-config-gen.py` - Nginx 설정 생성 (DynamoDB Stream → S3). 유저당 3 upstream: code-server(8080), frontend(3000), API(8000)
- `lib/lambda/ec2-idle-stop.py` - EC2 유휴 자동 중지 + Hibernate 지원 (ADR-010)
- `lib/lambda/idle-check.py` - EC2 유휴 상태 확인 (SSM 기반 CPU/세션 체크)
- `lib/lambda/gateway-manager.py` - MCP Gateway lifecycle 관리 (DDB Streams trigger, ADR-007)
- `lib/lambda/audit-logger.py` - 감사 로그
- `lib/lambda/devenv-session-validator/index.js` - NextAuth JWE 쿠키 검증 (Lambda@Edge viewer-request, ADR-013)
- `lib/lambda/devenv-origin-router/index.js` - Host 기반 origin 라우팅 (Lambda@Edge origin-request, ADR-013)

## Rules
- IAM Role은 사용하는 스택에서 생성 (cross-stack cyclic ref 방지)
- grantRead/grantPull 대신 broad ARN 패턴 사용
- CDK context로 파라미터 오버라이드: `cdk deploy -c vpcCidr=10.1.0.0/16`
- EC2-per-user DevEnv: Stack 07에서 Launch Template + per-user IAM 관리 (ECS devenv 제거됨)
- Stack 04는 ECS Cluster + Nginx 서비스만 유지 (Dashboard + 리버스 프록시)
- `governanceOnly=true` context: bin/app.ts에서 Stack 04/07 인스턴스화 skip, Stack 08만 추가 배포
- Local Governance role 이름: `cc-on-bedrock-local-user-{cognito_sub}` (EC2 모드의 `cc-on-bedrock-task-{subdomain}`과 prefix로 구분 — usage attribute에서 모드 식별)
