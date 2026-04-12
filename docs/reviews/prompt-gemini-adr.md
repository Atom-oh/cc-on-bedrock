cc-on-bedrock 프로젝트의 ADR(Architecture Decision Record) 문서 2개와 구현 코드를 리뷰해주세요.
이 프로젝트는 AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼입니다.

## 리뷰 대상

### ADR 문서 (반드시 모두 읽어주세요)
1. docs/decisions/ADR-007-dept-mcp-agentcore-gateway.md — 부서별 MCP Gateway 2-tier 아키텍처 (Status: Accepted)
2. docs/decisions/ADR-008-enterprise-sso-federation.md — Cognito User Pool Federation SAML/OIDC/Social (Status: Proposed)

### 구현 코드 (ADR-007 변경분, 반드시 모두 읽어주세요)
- cdk/lib/03-usage-tracking-stack.ts — CDK 스택 (DDB 테이블, Gateway Manager Lambda, DDB Streams)
- cdk/lib/lambda/gateway-manager.py — Gateway 생명주기 관리 Lambda (418줄)
- shared/nextjs-app/src/app/admin/mcp/mcp-management.tsx — Admin MCP 관리 UI
- shared/nextjs-app/src/app/api/admin/mcp/catalog/route.ts — MCP 카탈로그 API
- shared/nextjs-app/src/app/api/admin/mcp/gateways/route.ts — Gateway 관리 API
- shared/nextjs-app/src/lib/ec2-clients.ts — EC2 클라이언트 (gateway policy 적용)

### 기존 ADR (참고용 — 교차 참조에 활용)
- docs/decisions/ADR-004-ec2-per-user-devenv.md — 현재 EC2-per-user 아키텍처
- docs/decisions/ADR-005-bedrock-iam-cost-allocation.md — Bedrock IAM 비용 배분
- docs/decisions/ADR-006-department-budget-management.md — 부서 예산 관리

## 리뷰 기준

### 1. ADR 문서 품질
- 구조 완성도 (Context, Decision, Consequences, Risks, Alternatives 포함 여부)
- 결정 근거의 논리적 타당성
- 대안 분석의 충분성
- 제약사항과 리스크가 빠짐없이 기술되었는지

### 2. ADR 간 교차 일관성 (Gemini 강점 — 모든 파일을 교차 참조해주세요)
- ADR-007의 부서별 MCP 접근과 ADR-008의 SSO Federation이 상호 호환되는지
- Federated 사용자의 department 속성이 MCP Gateway 접근 제어에 올바르게 매핑되는지
- DynamoDB PK 형식(DEPT#{dept})이 모든 ADR과 코드에서 일관되는지
- IAM role naming convention이 ADR-005, 006, 007 간에 충돌 없는지

### 3. 설계-구현 정합성 (ADR-007)
- ADR-007에서 정의한 2-tier Gateway 구조가 코드에 충실히 반영되었는지
- DDB Streams → Lambda 트리거 흐름이 ADR 설명과 일치하는지
- 3-Layer IAM isolation이 실제 구현에서 지켜지고 있는지
- Catalog 기반 관리 패턴이 API와 UI에 올바르게 구현되었는지

### 4. 보안
- IAM permission scoping (최소 권한 원칙)
- Input validation (API route에서의 입력 검증)
- Secret handling (unsafeUnwrap 사용 여부)
- OWASP Top 10 관점

### 5. ADR-008 설계 검토
- Lambda trigger 구현 코드의 정확성 (PreSignUp, PostAuthentication, PreTokenGeneration V2)
- Cognito groups claim injection 방식의 올바름
- Domain allowlist 우회 가능성
- Social IdP에서 department 속성 누락 시 처리 방안

## 출력 형식

한국어로 구조화된 마크다운 리뷰를 작성해주세요.
각 발견사항에 심각도 (CRITICAL/HIGH/MEDIUM/LOW)를 부여하고, 가능하면 파일:라인 참조를 포함해주세요.
다음 섹션으로 그룹핑해주세요:
1. ADR 문서 품질
2. ADR 간 일관성 이슈
3. 설계-구현 정합성 Gap
4. 보안 이슈
5. AWS Best Practices
6. 개선 권고사항
