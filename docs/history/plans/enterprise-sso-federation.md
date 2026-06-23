# 작업계획서: Enterprise SSO Federation (ADR-008)

> 작성: 2026-05-12 | 상태: 계획 중 | 관련 ADR: ADR-008

## 배경
현재 cc-on-bedrock은 Cognito 네이티브 사용자만 지원 (admin이 `AdminCreateUser`로 생성, password로 로그인). 기업 도입을 위해 Azure AD / Okta / KeyCloak / Google / Apple / Facebook 같은 외부 IdP 연동이 필수. ADR-008이 아키텍처를 정의했으며 본 계획서는 점진 도입 절차를 정리한다.

## 목표
1. Cognito User Pool Federation을 통해 SAML / OIDC / Social 5가지 IdP를 지원
2. 기존 네이티브 사용자 로그인 흐름 무중단 (regression 없음)
3. Federated 사용자의 `cognito:groups` claim을 PreTokenGeneration V2 Lambda로 주입
4. Federated 사용자에 대해 Controlled JIT provisioning (admin 승인 후 subdomain 할당)
5. IdP 설정은 CDK context로 optional — 미설정 시 기존 동작 유지

## 핵심 데이터/리소스

### Cognito Lambda Triggers
- PreSignUp — federated 사용자 자동 확인 + 도메인 allowlist
- PostAuthentication — 첫 로그인 시 기본 그룹/속성 할당
- PreTokenGeneration V2 — 모든 토큰에 `cognito:groups` 주입

### Secrets Manager 신규 항목 (선택적, IdP별)
- `cc-on-bedrock/idp/google-oauth-secret`
- `cc-on-bedrock/idp/apple-signin-key` (.p8 private key)
- `cc-on-bedrock/idp/okta-client-secret`
- `cc-on-bedrock/idp/keycloak-client-secret`

### CDK Config 확장 (`cdk/config/default.ts`)
```typescript
federation?: {
  samlProviders?: Array<{ name, metadataUrl, identifiers, idpSignout }>;
  oidcProviders?: Array<{ name, clientId, clientSecretArn, issuerUrl, scopes, identifiers }>;
  socialProviders?: { google?: ..., apple?: ..., facebook?: ... };
  allowedEmailDomains?: string[];
}
```

## 작업 항목

### Phase 1 — 무리지 않는 인프라 변경 (Day 1)

기존 인증에 영향 없도록 IdP 리소스/트리거를 우선 도입.

- [ ] **1-1. CDK config 확장** (`cdk/config/default.ts`)
  - `federation?` optional 필드 추가
  - `defaultConfig`에는 `federation: undefined`
  - 인터페이스 type 정의 + JSDoc

- [ ] **1-2. Lambda 트리거 3개 작성** (`cdk/lib/lambda/cognito-*/index.js`)
  - `cognito-pre-signup/` — ADR-008 §"PreSignUp Lambda" 참고
  - `cognito-post-auth/` — ADR-008 §"PostAuthentication Lambda" 참고
  - `cognito-pre-token-gen/` — ADR-008 §"PreTokenGeneration V2 Lambda" 참고
  - 각 Lambda는 native 사용자에 대해 early-return (regression 방지)

- [ ] **1-3. SecurityStack 트리거 연결** (`cdk/lib/02-security-stack.ts`)
  - 트리거 3개 Lambda 생성 + IAM 권한 (cognito-idp:* on User Pool ARN)
  - `userPool.addTrigger(PRE_SIGN_UP, ...)`, `POST_AUTHENTICATION`, `PRE_TOKEN_GENERATION_CONFIG` with `LambdaVersion.V2_0`
  - PreTokenGeneration **V2 명시 필수** — V1으로 호출되면 `groupOverrideDetails` 무시됨

- [ ] **1-4. Native 사용자 regression 테스트**
  - 기존 사용자 email/password 로그인이 그대로 동작하는지 확인
  - `cognito:groups` claim이 PreTokenGen V2를 거쳐도 동일하게 유지되는지 확인
  - middleware.ts의 admin/dept-manager 라우트 보호가 그대로 작동하는지 확인

### Phase 2 — IdP 등록 (Day 2, IdP별 독립 작업)

IdP 등록은 외부 시스템 작업이 필요하므로 별도 IdP별로 PR을 나누는 것을 권장.

- [ ] **2-1. SAML 2.0 IdP 등록** (예: Azure AD)
  - Azure Portal에서 SAML Application 생성 + Attributes & Claims 매핑 (ADR-008 §"Azure AD" 참고)
  - Federation Metadata URL 확보 → SSM Parameter Store `/cc-on-bedrock/idp/azuread-metadata-url`에 저장
  - CDK `UserPoolIdentityProviderSaml` 추가 (`02-security-stack.ts`)
  - `UserPoolClient.supportedIdentityProviders`에 SAML provider 추가
  - 로그인 테스트: Cognito Hosted UI에 IdP 선택 옵션 노출 확인

- [ ] **2-2. OIDC IdP 등록** (예: Okta OIDC 또는 KeyCloak)
  - IdP에서 OIDC Web Application 등록 (ADR-008 §"Okta OIDC" / §"KeyCloak" 참고)
  - Client ID/Secret 발급 → Secrets Manager `/cc-on-bedrock/idp/okta-client-secret` 저장
  - CDK `UserPoolIdentityProviderOidc` 추가
  - **Issuer URL** 정확성 확인 (`/.well-known/openid-configuration` 응답 검증)

- [ ] **2-3. Social IdP 등록** (Google / Apple / Facebook 중 필요한 것만)
  - 각 vendor 콘솔에서 OAuth client 생성
  - Secrets Manager 저장 + CDK `UserPoolIdentityProvider{Google|Apple|Facebook}` 추가
  - Social provider는 `custom:department` 없음 → PostAuth Lambda에서 admin 수동 할당 안내 출력

각 IdP는 Phase 1이 머지된 뒤 **독립적으로** Phase 2-N PR로 진행 가능. 한 IdP가 실패해도 나머지 영향 없음.

### Phase 3 — Dashboard UX (Day 3)

- [ ] **3-1. Login page에 "Sign in with SSO" 버튼** (`shared/nextjs-app/src/app/login/page.tsx`)
  - 기존 email/password form 아래 구분선 + 버튼
  - `signIn("cognito")` 호출 → Cognito Hosted UI로 redirect → IdP 선택 화면
  - 디자인: ADR-008 §"Login Page 변경" 참고

- [ ] **3-2. Admin UI에서 federated 사용자 표시** (`shared/nextjs-app/src/lib/aws-clients.ts` + `app/admin/page.tsx`)
  - Cognito `ListUsersCommand` 결과의 `UserStatus === 'EXTERNAL_PROVIDER'` 식별
  - 사용자 테이블에 "Native | Federated" 컬럼 추가
  - Federated 사용자에게 admin이 `custom:subdomain` 할당하는 UI 추가 (기존 user 편집 폼 재활용)

- [ ] **3-3. Controlled JIT — "개발환경 미배정" 상태 UX**
  - Dashboard `/user` 페이지에서 `custom:subdomain` 미설정 사용자에게 "관리자 승인 대기 중" 배너 표시
  - "관리자에게 요청" 버튼 → Slack/Email 알림 (선택, 후속 PR)

### Phase 4 — 문서 / 테스트 (Day 4)

- [ ] **4-1. IdP별 관리자 가이드** (`docs/runbooks/sso-azure-ad.md`, `docs/runbooks/sso-okta.md`, `docs/runbooks/sso-keycloak.md`, `docs/runbooks/sso-google.md`)
  - 각 vendor 콘솔 설정 스크린샷 + Attribute mapping 표
  - CDK context 예시 + 배포 명령

- [ ] **4-2. E2E 테스트** (`tests/integration/test-sso-federation.sh`)
  - Selenium/Playwright 또는 manual 절차
  - Native 로그인 회귀, Federated 로그인 성공, Group claim 주입 확인, Dashboard 접근, DevEnv `*.dev.<domain>` 접근

- [ ] **4-3. README 업데이트** — Enterprise SSO 한 줄 소개 + ADR-008 링크

- [ ] **4-4. ADR-008 status를 "Accepted"로 갱신** (배포 검증 완료 후)

## 검증 기준

1. CDK synth: 기존 모드(federation 미설정), federation 1개 설정, 다중 IdP 모드 모두 성공
2. 기존 native 사용자의 email/password 로그인이 그대로 동작 (regression test)
3. SSO 버튼 클릭 → Cognito Hosted UI → IdP 선택 → 성공 콜백 → Dashboard 진입
4. Federated 사용자의 JWT에 `cognito:groups`가 배열로 포함 (Network 탭 / `jwt.io`로 검증)
5. Federated 사용자 첫 로그인 후 PostAuth Lambda가 `custom:resource_tier=standard` 등 기본값 설정 확인 (Cognito 콘솔)
6. Federated 사용자에 admin이 subdomain 할당 → DevEnv 시작 → `*.dev.<domain>` 접속 가능
7. Lambda 트리거 평균 latency < 200ms (CloudWatch Lambda Insights)
8. Native 사용자 트리거 영향: PreTokenGeneration이 native에서도 호출되지만 동일 group 결과 유지
9. 도메인 allowlist 동작: `ALLOWED_DOMAINS` 외 이메일로 federated 로그인 시 차단

## 위험 / 롤백

| 위험 | 영향 | 완화 |
|---|---|---|
| PreTokenGeneration V1로 잘못 연결 시 groups 누락 | admin 권한 분실 → 인가 실패 | `LambdaVersion.V2_0` 명시 + 검증 테스트 |
| Lambda 트리거 장애가 모든 로그인 차단 | 100% 인증 down | 트리거에 try/catch + native early-return + CloudWatch 알람 |
| Federated email 중복 충돌 | 같은 이메일로 native 사용자가 있을 때 충돌 | PreSignUp에서 `AdminLinkProviderForUser`로 연결 또는 명시적 에러 |
| Cognito Hosted UI 미커스터마이즈 | 브랜드 일관성 손상 | Custom domain (cdkCognitoDomain) + CSS 커스터마이즈로 후속 보완 |
| IdP 측 metadata URL TLS 만료 | SAML 갱신 시점에 인증 중단 | metadata URL → SSM Parameter로 운영, 만료 모니터링 추가 |

## 마이그레이션 노트

- 기존 native 사용자는 그대로 유지. 마이그레이션 없음.
- 동일 email의 native + federated 공존 케이스: 기본은 별도 사용자 (Cognito 기본 동작). `LINK_EXISTING_USERS=true` 환경변수로 PreSignUp Lambda가 자동 연결하도록 설정 가능 (ADR-008 §"User Linking" 참고).
- Native 사용자 비활성화 정책: 회사 차원에서 SSO 강제 시 admin이 native 사용자를 `AdminDisableUser`로 비활성화. 또는 별도 PR로 `CredentialsProvider` 토글 환경변수 추가.

## Out of Scope (별 ADR 필요)
- Cognito Custom Domain 적용 (브랜드 도메인 `auth.<your-org>.com`)
- IdP 측 SCIM provisioning (사용자 자동 동기화)
- MFA 강제 정책 (Cognito Advanced Security Features)
- Social IdP 사용자에 대한 자동 부서 할당 규칙 (이메일 도메인 기반 규칙 엔진)

## 의존 / 영향
- 본 계획서가 머지되면 ADR-008 status를 "Proposed" → "Implementing" → "Accepted"로 단계 갱신
- ADR-014 Local Governance Mode와 충돌 없음 — STS Issuer Lambda가 NextAuth session 기반이라 federated/native 모두 동일하게 동작
- ADR-007 dept MCP Gateway와 충돌 없음 — `custom:department`가 IdP에서 매핑되어 동일하게 사용
- ADR-016 CloudFront split과 충돌 없음 — Lambda@Edge session-validator는 NextAuth cookie만 검증, IdP 무관

## References
- ADR-008: Enterprise SSO Federation (상세 아키텍처)
- AWS docs: Cognito User Pool Identity Providers
- AWS docs: PreTokenGeneration V2 trigger
- 관련 파일: `cdk/lib/02-security-stack.ts`, `cdk/config/default.ts`, `shared/nextjs-app/src/lib/auth.ts`, `shared/nextjs-app/src/app/login/page.tsx`
