cc-on-bedrock 프로젝트의 ADR 문서 2개와 구현 코드를 AWS Well-Architected Framework 관점에서 리뷰해주세요.

## 리뷰 대상

### ADR 문서
1. docs/decisions/ADR-007-dept-mcp-agentcore-gateway.md — 부서별 MCP Gateway 2-tier 아키텍처 (Accepted)
2. docs/decisions/ADR-008-enterprise-sso-federation.md — Cognito Federation SAML/OIDC/Social (Proposed)

### 구현 코드 (ADR-007)
- cdk/lib/03-usage-tracking-stack.ts — CDK 스택
- cdk/lib/lambda/gateway-manager.py — Gateway Manager Lambda
- shared/nextjs-app/src/app/admin/mcp/mcp-management.tsx — Admin UI
- shared/nextjs-app/src/app/api/admin/mcp/catalog/route.ts — 카탈로그 API
- shared/nextjs-app/src/app/api/admin/mcp/gateways/route.ts — Gateway API
- shared/nextjs-app/src/lib/ec2-clients.ts — EC2 클라이언트

## AWS Well-Architected 관점 리뷰

### Security Pillar
- IAM 최소 권한: gateway-manager Lambda의 iam:CreateRole, iam:PassRole 범위가 적절한지
- Permission Boundary가 모든 동적 생성 Role에 적용되는지
- DynamoDB 데이터 암호화 (at rest, in transit)
- Cognito Federation: PreSignUp Lambda의 domain allowlist 우회 가능성
- PreTokenGeneration V2의 groups claim injection이 안전한지
- Lambda@Edge auth와 federation auth의 defense-in-depth 구조

### Reliability Pillar
- DDB Streams → Lambda 이벤트 소스 매핑: reportBatchItemFailures, DLQ 설정
- Gateway Manager Lambda의 에러 처리 및 재시도 로직
- AgentCore Gateway API 호출 실패 시 복구 전략
- EC2 config sync (systemd oneshot) 실패 시 영향 범위

### Cost Optimization Pillar
- Lambda 실행 빈도와 비용 (DDB Streams 트리거 빈도)
- AgentCore Gateway per-department vs shared 비용 비교
- Cognito Lambda trigger 추가 비용 (PreSignUp + PostAuth + PreTokenGen)

### Performance Pillar
- DynamoDB 테이블 설계: PK/SK 패턴, GSI 필요성, hot partition 위험
- Lambda cold start 영향 (gateway-manager.py 크기와 의존성)
- Cognito Lambda trigger 추가 지연 (+50-200ms)

### Operational Excellence Pillar
- CDK construct 패턴 (L2 vs L1, RemovalPolicy)
- 모니터링: CloudWatch 알람, 메트릭 정의 여부
- 배포: Gateway 생성/삭제 중 부분 실패 시 상태 관리

## CDK 패턴 검토
- DynamoDB Table construct: billingMode, encryption, pointInTimeRecovery
- Lambda Function construct: runtime, timeout, memorySize, reserved concurrency
- DDB Streams EventSourceMapping: batchSize, bisectBatchOnFunctionError, retryAttempts
- IAM Role/Policy: permission boundary, condition keys
- Stack 간 의존성: cross-stack 참조 대신 SSM Parameter 사용 여부

## Cognito Federation 패턴 (ADR-008)
- UserPoolIdentityProviderSaml/Oidc construct 사용법
- AttributeMapping 완전성 (SAML assertion → Cognito attributes)
- Lambda trigger V2 response format 정확성
- Social IdP (Google, Apple, Facebook) secret 관리 방식

## 출력 형식

한국어로 구조화된 마크다운 리뷰를 작성해주세요.
Well-Architected Pillar별로 그룹핑하고, 각 발견사항에 심각도를 부여해주세요.
파일:라인 참조를 가능한 한 포함해주세요.
