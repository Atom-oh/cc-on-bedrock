cc-on-bedrock 프로젝트의 ADR 구현 코드를 보안과 정확성 관점에서 리뷰해주세요.

## 리뷰 대상 파일 (모두 읽어주세요)

### ADR-007 구현 코드
1. cdk/lib/03-usage-tracking-stack.ts — CDK 스택 (DDB, Lambda, Streams)
2. cdk/lib/lambda/gateway-manager.py — Gateway Manager Lambda (핵심 파일)
3. shared/nextjs-app/src/app/api/admin/mcp/catalog/route.ts — 카탈로그 API
4. shared/nextjs-app/src/app/api/admin/mcp/gateways/route.ts — Gateway API
5. shared/nextjs-app/src/lib/ec2-clients.ts — EC2 클라이언트

### ADR-008 설계 문서 (Lambda 코드 포함)
6. docs/decisions/ADR-008-enterprise-sso-federation.md — Cognito Federation (Lambda trigger 코드 포함)

## 리뷰 초점 (코드 정확성 + 보안)

### 1. gateway-manager.py Lambda
- DynamoDB Streams 이벤트 파싱 정확성 (INSERT/MODIFY/REMOVE 처리)
- AgentCore Gateway API 호출 에러 처리
- IAM Role 생성/삭제 시 race condition 가능성
- boto3 클라이언트 초기화 위치 (cold start 최적화)
- 예외 처리 누락 (bare except, broad exception)

### 2. API Routes (catalog, gateways)
- Input validation 완전성 (ALLOWED_FIELDS whitelist)
- DynamoDB 쿼리 injection 방지
- 인증/인가 체크 유무
- HTTP 응답 코드 적절성
- Error response에 내부 정보 노출 여부

### 3. CDK Stack 변경
- IAM 권한 scoping (Resource: * 사용 여부)
- DDB Streams EventSourceMapping 설정 (bisectBatchOnFunctionError, retryAttempts)
- Lambda 환경변수에 민감 정보 포함 여부
- RemovalPolicy 설정 적절성

### 4. ADR-008 Lambda Trigger 코드
- PreSignUp: domain allowlist 우회 가능한 edge case
- PostAuthentication: first-login 감지 로직의 정확성
- PreTokenGeneration V2: cognito:groups claim을 JSON.stringify로 설정하는게 올바른지 (string vs array)
- Error 발생 시 사용자 로그인이 차단되는지 여부
- unsafeUnwrap() 사용 (ADR-008 line ~363) — secret이 CFN 템플릿에 평문 노출

### 5. ec2-clients.ts 변경
- PK 형식 변경 (COMMON → DEPT#COMMON) 일관성
- Gateway policy 적용 함수의 에러 처리
- 타입 안전성

## 출력 형식

한국어로 구조화된 마크다운 리뷰를 작성해주세요.
각 발견사항에 심각도 (CRITICAL/HIGH/MEDIUM/LOW)와 confidence (0-100)를 부여해주세요.
파일:라인 참조를 반드시 포함해주세요.
confidence 75 이상인 이슈만 보고해주세요.
