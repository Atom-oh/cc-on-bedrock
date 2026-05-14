# ADR-008: Enterprise SSO Federation (SAML / OIDC / Social)

## Status
Suspended (2026-04-26) — 실제 IdP(Azure AD/Okta) 메타데이터 필요. 고객 환경 확보 후 재개.

## Context

cc-on-bedrock은 현재 **Cognito 네이티브 사용자만** 지원한다:
- Admin이 `AdminCreateUser`로 사용자 생성
- 사용자는 email/password로 직접 로그인 (CredentialsProvider → `USER_PASSWORD_AUTH`)
- Cognito Hosted UI 기반 OAuth도 지원 (CognitoProvider)
- `selfSignUpEnabled: false` — 셀프 가입 불가

엔터프라이즈 환경에서는 기존 IdP(Azure AD, Okta, KeyCloak, ADFS)나 소셜 로그인(Google, Apple, Facebook)과의 연동이 필수적이다. 이 ADR은 Cognito Federation을 통한 외부 IdP 통합 아키텍처를 정의한다.

### 현재 인증 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                      cc-on-bedrock Auth                        │
│                                                                 │
│  Dashboard (NextAuth.js)          DevEnv (Lambda@Edge)         │
│  ├─ CognitoProvider (OAuth)       └─ Cognito OAuth             │
│  └─ CredentialsProvider            └─ HMAC cookie              │
│     (USER_PASSWORD_AUTH)              (custom:subdomain 검증)   │
│                                                                 │
│  Cognito User Pool: cc-on-bedrock-users                        │
│  ├─ 8 custom attributes (subdomain, department, ...)           │
│  ├─ 2 UserPoolClients (AppClient, DevEnvAuthClient)            │
│  ├─ 3 Groups (admin, user, dept-manager)                       │
│  └─ Hosted UI domain: cc-on-bedrock-ent.auth.ap-northeast-2   │
└─────────────────────────────────────────────────────────────────┘
```

**핵심 파일:**
- CDK: `cdk/lib/02-security-stack.ts` — Cognito User Pool, Clients, Groups
- Auth: `shared/nextjs-app/src/lib/auth.ts` — NextAuth CognitoProvider + CredentialsProvider
- Edge: `cdk/lib/lambda/devenv-auth-edge/index.js` — Lambda@Edge OAuth
- Config: `cdk/config/default.ts` — `CcOnBedrockConfig` interface

## Decision

Cognito User Pool Federation을 통해 **5가지 유형의 외부 IdP**를 지원한다.

### 지원 IdP 유형

| 유형 | IdP 예시 | CDK Construct | 프로토콜 |
|------|----------|---------------|----------|
| **SAML 2.0** | Azure AD (Entra ID), ADFS, Okta SAML | `UserPoolIdentityProviderSaml` | SAML 2.0 |
| **OIDC** | Okta OIDC, KeyCloak, Auth0 | `UserPoolIdentityProviderOidc` | OpenID Connect |
| **Google** | Google Workspace | `UserPoolIdentityProviderGoogle` | OAuth 2.0 |
| **Apple** | Apple ID | `UserPoolIdentityProviderApple` | OAuth 2.0 |
| **Facebook** | Facebook Login | `UserPoolIdentityProviderFacebook` | OAuth 2.0 |

### 대안 분석

| Option | 채택 여부 | 이유 |
|--------|-----------|------|
| **Cognito Federation** (채택) | O | 기존 User Pool 재사용, Lambda@Edge 변경 불필요, CDK 지원 |
| Cognito Identity Pool | X | User Pool과 별개 인증 계층, 불필요한 복잡도 |
| 별도 OIDC Proxy (Keycloak) | X | 추가 인프라 운영 비용, Cognito가 이미 지원 |
| NextAuth 직접 연동 | X | Lambda@Edge DevEnv 인증과 분리됨, 이중 관리 |

## Architecture

### Federation 인증 플로우

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│  Login   │────>│ Cognito      │────>│ External IdP │
│  Page    │     │ Hosted UI    │     │ (SAML/OIDC)  │
│  "SSO"   │     │ IdP 선택화면  │     │              │
└──────────┘     └──────────────┘     └──────┬───────┘
                                             │ SAML Response
                                             │ or OIDC Token
                       ┌─────────────────────┘
                       ▼
              ┌─────────────────┐
              │ Cognito         │  Shadow User 생성/연결
              │ User Pool       │
              └───────┬─────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌──────────────┐
   │PreSignUp │ │PostAuth  │ │PreTokenGen   │
   │Lambda    │ │Lambda    │ │V2 Lambda     │
   │자동확인   │ │그룹/속성  │ │groups claim  │
   │allowlist │ │기본값     │ │주입          │
   └──────────┘ └──────────┘ └──────────────┘
                      │
                      ▼
              ┌─────────────────┐
              │ Cognito Token   │  ID Token + Access Token
              │ (with groups)   │  custom attributes 포함
              └───────┬─────────┘
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
   ┌──────────────┐         ┌──────────────┐
   │ Dashboard    │         │ DevEnv       │
   │ NextAuth     │         │ Lambda@Edge  │
   │ CognitoProvi │         │ OAuth flow   │
   │ der callback │         │ (변경 없음)   │
   └──────────────┘         └──────────────┘
```

### 기존 로그인과의 공존

```
Login Page
├── [Email / Password Form]     ← 네이티브 Cognito 사용자
│   └── signIn("cognito-credentials")
│       └── USER_PASSWORD_AUTH → Cognito 직접 인증
│
├── [SSO로 로그인] 버튼          ← Federated 사용자
│   └── signIn("cognito")
│       └── Cognito Hosted UI → IdP 선택 → SAML/OIDC
│
└── [Google / Apple / Facebook] ← Social 로그인
    └── signIn("cognito", { identity_provider: "Google" })
        └── Cognito → Google OAuth → callback
```

**Federated 사용자는 `USER_PASSWORD_AUTH` 사용 불가** — Cognito에 비밀번호가 없으므로 반드시 OAuth(Hosted UI) 경로를 사용해야 한다.

## 핵심 설계 결정

### 1. Custom Attribute 매핑 전략

cc-on-bedrock의 8개 custom attribute 중 IdP에서 매핑 가능한 것과 플랫폼이 관리하는 것을 구분한다:

| Attribute | 소스 | 매핑 방법 |
|-----------|------|-----------|
| `custom:department` | **IdP** | SAML assertion / OIDC claim 매핑 |
| `email`, `name` | **IdP** | 표준 attribute 매핑 |
| `custom:subdomain` | **플랫폼** | Admin이 할당 (EC2/DNS 매핑 필수) |
| `custom:resource_tier` | **플랫폼** | 기본값 `standard`, admin 변경 |
| `custom:security_policy` | **플랫폼** | 기본값 `restricted`, admin 변경 |
| `custom:container_os` | **플랫폼** | 기본값 `ubuntu`, 사용자 선택 |
| `custom:storage_type` | **플랫폼** | 기본값 `ebs` |
| `custom:container_id` | **런타임** | EC2 시작 시 자동 설정 |
| `custom:budget_exceeded` | **런타임** | Lambda budget-check가 설정 |

### 2. Cognito Groups 주입 — PreTokenGeneration V2 필수

**문제:** Cognito는 federated 사용자의 `cognito:groups`를 토큰에 자동 포함하지 않는다.

**해결:** PreTokenGeneration V2 Lambda 트리거가 `AdminListGroupsForUser`를 호출하여 groups claim을 토큰에 주입.

이는 전체 인가 체계(NextAuth JWT callback → middleware.ts → API route 보호)가 `cognito:groups`에 의존하기 때문에 **필수**이다.

### 3. 온보딩 전략: Controlled JIT (Just-In-Time) Provisioning

```
Federated 사용자 첫 로그인
  │
  ├── PreSignUp Lambda
  │   ├── autoConfirmUser = true
  │   ├── autoVerifyEmail = true
  │   └── (선택) 도메인 allowlist 검증
  │
  ├── PostAuthentication Lambda (첫 로그인만)
  │   ├── AdminAddUserToGroup → "user"
  │   ├── AdminUpdateUserAttributes
  │   │   ├── custom:resource_tier = "standard"
  │   │   ├── custom:security_policy = "restricted"
  │   │   ├── custom:container_os = "ubuntu"
  │   │   └── custom:storage_type = "ebs"
  │   └── (custom:subdomain은 미설정 → admin 할당 대기)
  │
  └── Dashboard 접근
      ├── 프로필 정보 표시 (email, department, 설정)
      ├── "개발환경 미배정" 상태 표시
      └── admin 승인 후 subdomain 할당 → EC2 시작 가능
```

**이유:** `custom:subdomain`은 EC2 인스턴스, DNS 레코드, DynamoDB 라우팅, Lambda@Edge 접근제어와 직결되어 있어 자동 할당이 위험하다. 기존 admin 관리 모델(`selfSignUpEnabled: false`)의 철학을 유지한다.

### 4. 변경 필요 / 불필요 영역 분석

#### 변경 불필요 (기존 코드가 이미 호환)

| 파일 | 이유 |
|------|------|
| `shared/nextjs-app/src/lib/auth.ts` | CognitoProvider OAuth callback이 federated 토큰을 동일하게 처리. `profile["custom:subdomain"]` 등 이미 매핑됨 |
| `shared/nextjs-app/src/middleware.ts` | `token.groups.includes("admin")` — auth source 무관 |
| `cdk/lib/lambda/devenv-auth-edge/index.js` | Cognito Hosted UI가 IdP redirect를 투명하게 처리. Lambda@Edge는 Cognito 토큰만 검증 |
| DynamoDB 테이블, EC2, Nginx routing | Identity-agnostic — subdomain 기반 |

#### 변경 필요

| 파일 | 변경 내용 |
|------|-----------|
| `cdk/config/default.ts` | `federation?` config 인터페이스 추가 |
| `cdk/lib/02-security-stack.ts` | IdP 리소스, Lambda 트리거 3개, Client `supportedIdentityProviders` |
| `shared/nextjs-app/src/app/login/page.tsx` | "SSO로 로그인" 버튼 추가 |
| `shared/nextjs-app/src/lib/aws-clients.ts` | `EXTERNAL_PROVIDER` 사용자 표시 처리 |

## IdP별 구성 가이드

### 1. SAML 2.0 — Azure AD (Entra ID)

**Cognito SP 정보 (IdP에 등록):**
```
Entity ID:     urn:amazon:cognito:sp:{userPoolId}
ACS URL:       https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/saml2/idpresponse
Sign-on URL:   https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/saml2/idpresponse
```

**Azure AD 설정:**
1. Azure Portal → Enterprise Applications → New Application → Create your own → Non-gallery
2. Single sign-on → SAML
3. Basic SAML Configuration: Entity ID + Reply URL (ACS URL) 입력
4. Attributes & Claims 매핑:

| Cognito Attribute | SAML Claim URI |
|-------------------|----------------|
| `email` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |
| `given_name` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` |
| `family_name` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname` |
| `custom:department` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/department` |

5. Federation Metadata XML URL 복사 → CDK config에 설정

**CDK 구현:**
```typescript
// cdk/lib/02-security-stack.ts
const azureAd = new cognito.UserPoolIdentityProviderSaml(this, 'AzureAD', {
  userPool: this.userPool,
  name: 'AzureAD',
  metadata: cognito.UserPoolIdentityProviderSamlMetadata.url(
    config.federation!.samlProviders![0].metadataUrl!
  ),
  identifiers: ['azuread'],  // identity_provider param 값
  idpSignout: true,
  attributeMapping: {
    email: cognito.ProviderAttribute.other(
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
    ),
    givenName: cognito.ProviderAttribute.other(
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'
    ),
    familyName: cognito.ProviderAttribute.other(
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'
    ),
    custom: {
      'custom:department': cognito.ProviderAttribute.other(
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/department'
      ),
    },
  },
});
```

### 2. SAML 2.0 — Okta SAML

**Okta 설정:**
1. Okta Admin → Applications → Create App Integration → SAML 2.0
2. Single sign-on URL: `https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/saml2/idpresponse`
3. Audience URI (SP Entity ID): `urn:amazon:cognito:sp:{userPoolId}`
4. Attribute Statements:

| Name | Value |
|------|-------|
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | `user.email` |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` | `user.firstName` |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/department` | `user.department` |

5. Identity Provider metadata URL 복사

**CDK:** `UserPoolIdentityProviderSaml` — Azure AD와 동일 구조, metadata URL만 다름.

### 3. OIDC — Okta OIDC

**Okta 설정:**
1. Okta Admin → Applications → Create App Integration → OIDC - Web Application
2. Sign-in redirect URI: `https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/oauth2/idpresponse`
3. Sign-out redirect URI: Dashboard URL
4. Client ID / Client Secret 복사

**CDK 구현:**
```typescript
const oktaOidc = new cognito.UserPoolIdentityProviderOidc(this, 'OktaOIDC', {
  userPool: this.userPool,
  name: 'Okta',
  clientId: config.federation!.oidcProviders![0].clientId,
  clientSecret: cdk.SecretValue.secretsManager(
    config.federation!.oidcProviders![0].clientSecretArn
  ).unsafeUnwrap(),
  issuerUrl: config.federation!.oidcProviders![0].issuerUrl,
  // e.g., 'https://your-org.okta.com/oauth2/default'
  scopes: ['openid', 'email', 'profile'],
  identifiers: ['okta'],
  attributeMapping: {
    email: cognito.ProviderAttribute.other('email'),
    fullname: cognito.ProviderAttribute.other('name'),
    custom: {
      'custom:department': cognito.ProviderAttribute.other('department'),
    },
  },
  endpoints: {
    // Okta auto-discovery: /.well-known/openid-configuration
    // Cognito resolves automatically from issuerUrl
    authorization: `${config.federation!.oidcProviders![0].issuerUrl}/v1/authorize`,
    token: `${config.federation!.oidcProviders![0].issuerUrl}/v1/token`,
    userInfo: `${config.federation!.oidcProviders![0].issuerUrl}/v1/userinfo`,
    jwksUri: `${config.federation!.oidcProviders![0].issuerUrl}/v1/keys`,
  },
});
```

### 4. OIDC — KeyCloak

**KeyCloak 설정:**
1. Realm → Clients → Create Client
2. Client ID: `cc-on-bedrock`
3. Valid Redirect URIs: `https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/oauth2/idpresponse`
4. Client authentication: ON → Credentials tab에서 Client Secret 복사
5. Mappers에서 `department` claim 추가 (User Attribute → department)

**CDK:** `UserPoolIdentityProviderOidc` — Okta OIDC와 동일 구조.

Issuer URL 형식: `https://{keycloak-host}/realms/{realm-name}`

### 5. Social — Google

**Google Cloud Console 설정:**
1. APIs & Services → Credentials → OAuth 2.0 Client ID → Web application
2. Authorized redirect URIs: `https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/oauth2/idpresponse`
3. Client ID / Client Secret 복사

**CDK 구현:**
```typescript
const google = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
  userPool: this.userPool,
  clientId: config.federation!.socialProviders!.google!.clientId,
  clientSecretValue: cdk.SecretValue.secretsManager('cc-on-bedrock/google-oauth-secret'),
  scopes: ['openid', 'email', 'profile'],
  attributeMapping: {
    email: cognito.ProviderAttribute.GOOGLE_EMAIL,
    fullname: cognito.ProviderAttribute.GOOGLE_NAME,
    // Google은 department claim이 없음 → PostAuth Lambda에서 처리
  },
});
```

**주의:** Social IdP는 `department` claim을 제공하지 않으므로, PostAuthentication Lambda에서 기본 부서를 설정하거나 admin이 수동 할당해야 한다.

### 6. Social — Apple

**Apple Developer 설정:**
1. Certificates, Identifiers & Profiles → Services ID 생성
2. Sign in with Apple → Web Authentication Configuration
3. Return URLs: `https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/oauth2/idpresponse`
4. Key 생성 (Sign in with Apple) → Key ID + .p8 파일

**CDK 구현:**
```typescript
const apple = new cognito.UserPoolIdentityProviderApple(this, 'Apple', {
  userPool: this.userPool,
  clientId: 'com.example.cc-on-bedrock',  // Services ID
  teamId: config.federation!.socialProviders!.apple!.teamId,
  keyId: config.federation!.socialProviders!.apple!.keyId,
  privateKey: cdk.SecretValue.secretsManager('cc-on-bedrock/apple-signin-key').unsafeUnwrap(),
  scopes: ['email', 'name'],
  attributeMapping: {
    email: cognito.ProviderAttribute.APPLE_EMAIL,
    fullname: cognito.ProviderAttribute.APPLE_NAME,
  },
});
```

### 7. Social — Facebook

**Meta Developer Console 설정:**
1. My Apps → Create App → Consumer → Facebook Login
2. Valid OAuth Redirect URIs: `https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/oauth2/idpresponse`
3. App ID / App Secret 복사

**CDK 구현:**
```typescript
const facebook = new cognito.UserPoolIdentityProviderFacebook(this, 'Facebook', {
  userPool: this.userPool,
  clientId: config.federation!.socialProviders!.facebook!.appId,
  clientSecret: config.federation!.socialProviders!.facebook!.appSecret,
  scopes: ['email', 'public_profile'],
  attributeMapping: {
    email: cognito.ProviderAttribute.FACEBOOK_EMAIL,
    fullname: cognito.ProviderAttribute.FACEBOOK_NAME,
  },
});
```

## Lambda 트리거 상세

### 1. PreSignUp Lambda (`cognito-pre-signup/index.js`)

Federated 사용자 자동 확인 + 선택적 도메인 allowlist 검증.

```javascript
const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminLinkProviderForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const client = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  // Federated 사용자만 처리 (네이티브 Cognito 사용자는 admin이 생성)
  if (event.triggerSource === 'PreSignUp_ExternalProvider') {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;

    // 허용 도메인 검증 (ALLOWED_DOMAINS 미설정 시 기본 차단)
    const allowedDomains = (process.env.ALLOWED_DOMAINS || '').split(',').filter(Boolean);
    if (allowedDomains.length === 0 && process.env.ALLOW_ALL_DOMAINS !== 'true') {
      throw new Error('ALLOWED_DOMAINS not configured — rejecting federation signup');
    }
    if (allowedDomains.length > 0) {
      const emailDomain = event.request.userAttributes.email?.split('@')[1];
      if (!emailDomain || !allowedDomains.includes(emailDomain)) {
        throw new Error(`Email domain ${emailDomain} is not allowed`);
      }
    }

    // 동일 email 네이티브 사용자 존재 시 계정 연결 (LINK_EXISTING_USERS=true일 때)
    if (process.env.LINK_EXISTING_USERS === 'true') {
      const email = event.request.userAttributes.email;
      const existing = await client.send(new ListUsersCommand({
        UserPoolId: event.userPoolId,
        Filter: `email = "${email}"`,
        Limit: 1,
      }));
      if (existing.Users?.length > 0) {
        const nativeUser = existing.Users[0];
        // federated identity를 기존 네이티브 사용자에 연결
        const [providerName, providerUserId] = event.userName.split('_');
        await client.send(new AdminLinkProviderForUserCommand({
          UserPoolId: event.userPoolId,
          DestinationUser: {
            ProviderName: 'Cognito',
            ProviderAttributeValue: nativeUser.Username,
          },
          SourceUser: {
            ProviderName: providerName,          // e.g., 'Google', 'AzureAD'
            ProviderAttributeName: 'Cognito_Subject',
            ProviderAttributeValue: providerUserId,
          },
        }));
      }
    }
  }
  return event;
};
```

**User Linking 동작:**
- `LINK_EXISTING_USERS=true`: 동일 email 네이티브 사용자 발견 시 `AdminLinkProviderForUser`로 연결. 연결 후 federated 로그인 시 네이티브 사용자의 그룹/속성을 그대로 사용.
- `LINK_EXISTING_USERS` 미설정 (기본): Cognito가 별도 shadow 사용자를 생성. 동일 email이지만 독립 계정.

### 2. PostAuthentication Lambda (`cognito-post-auth/index.js`)

첫 로그인 시 기본 그룹 및 속성 할당.

```javascript
const {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminUpdateUserAttributesCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const client = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  if (event.triggerSource !== 'PostAuthentication_Authentication') return event;

  // Federated 사용자만 처리
  const identities = JSON.parse(event.request.userAttributes.identities || '[]');
  if (identities.length === 0) return event;  // 네이티브 사용자 skip

  const { userPoolId } = event;
  const username = event.userName;

  // 이미 그룹에 속해있으면 (첫 로그인이 아님) skip
  const groups = await client.send(new AdminListGroupsForUserCommand({
    UserPoolId: userPoolId,
    Username: username,
  }));
  if (groups.Groups && groups.Groups.length > 0) return event;

  // 첫 로그인: 기본 그룹 할당
  await client.send(new AdminAddUserToGroupCommand({
    UserPoolId: userPoolId,
    Username: username,
    GroupName: process.env.DEFAULT_GROUP || 'user',
  }));

  // 기본 속성 설정 (미설정된 것만)
  const attrs = event.request.userAttributes;
  const updates = [];
  if (!attrs['custom:resource_tier'])   updates.push({ Name: 'custom:resource_tier',   Value: 'standard' });
  if (!attrs['custom:security_policy']) updates.push({ Name: 'custom:security_policy', Value: 'restricted' });
  if (!attrs['custom:container_os'])    updates.push({ Name: 'custom:container_os',    Value: 'ubuntu' });
  if (!attrs['custom:storage_type'])    updates.push({ Name: 'custom:storage_type',    Value: 'ebs' });

  if (updates.length > 0) {
    await client.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId,
      Username: username,
      UserAttributes: updates,
    }));
  }

  return event;
};
```

### 3. PreTokenGeneration V2 Lambda (`cognito-pre-token-gen/index.js`)

Federated 사용자의 `cognito:groups` claim을 토큰에 주입.

```javascript
const {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const client = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  const { userPoolId } = event;
  const username = event.userName;

  const result = await client.send(new AdminListGroupsForUserCommand({
    UserPoolId: userPoolId,
    Username: username,
  }));

  const groupNames = (result.Groups || []).map(g => g.GroupName);

  // V2 응답 형식: groupOverrideDetails로 cognito:groups 주입
  // NOTE: cognito:groups는 reserved claim이므로 claimsToAddOrOverride가 아닌
  // groupOverrideDetails를 사용해야 Access Token과 ID Token 모두에 배열로 반영됨
  event.response = {
    claimsAndScopeOverrideDetails: {
      groupOverrideDetails: {
        groupsToOverride: groupNames,
      },
    },
  };

  return event;
};
```

**주의:** PreTokenGeneration V2 Lambda는 **모든 인증 이벤트**에서 실행된다 (네이티브 + federated). 네이티브 사용자의 경우에도 groups를 정확히 주입하므로 기존 동작에 영향 없음. 단, 모든 로그인에 ~50ms latency가 추가된다.

## CDK 변경 가이드

### Config 인터페이스 확장 (`cdk/config/default.ts`)

```typescript
export interface CcOnBedrockConfig {
  // ... 기존 필드 ...

  // Federation (optional — 설정 없으면 기존 동작 유지)
  federation?: {
    samlProviders?: Array<{
      name: string;              // e.g., 'AzureAD', 'OktaSAML'
      metadataUrl?: string;      // SAML Federation Metadata URL
      metadataContent?: string;  // or inline XML (mutually exclusive)
      identifiers?: string[];    // identity_provider param 라우팅용
      idpSignout?: boolean;
    }>;
    oidcProviders?: Array<{
      name: string;              // e.g., 'Okta', 'KeyCloak'
      clientId: string;
      clientSecretArn: string;   // Secrets Manager ARN (평문 저장 금지)
      issuerUrl: string;         // e.g., 'https://org.okta.com/oauth2/default'
      scopes?: string[];
      identifiers?: string[];
    }>;
    socialProviders?: {
      google?: { clientId: string; clientSecretArn: string };
      apple?: { clientId: string; teamId: string; keyId: string; privateKeyArn: string };
      facebook?: { appId: string; appSecret: string };
    };
    allowedEmailDomains?: string[];  // PreSignUp allowlist (빈 배열 = 전체 허용)
  };
}
```

### Security Stack 변경 (`cdk/lib/02-security-stack.ts`)

1. IdP 리소스 생성 (config.federation 기반 조건부)
2. Lambda 트리거 3개 생성 + IAM 권한
3. **PreTokenGeneration 트리거 연결 시 `lambdaVersion: cognito.LambdaVersion.V2_0` 필수** — 미지정 시 V1 형식으로 호출되어 `groupOverrideDetails`가 무시됨
4. UserPoolClient에 `supportedIdentityProviders` 추가
5. Client → Provider dependency 설정

```typescript
// PreTokenGeneration V2 트리거 연결 예시
this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, preTokenGenFn, cognito.LambdaVersion.V2_0);
```

### Login Page 변경 (`shared/nextjs-app/src/app/login/page.tsx`)

```tsx
{/* SSO Login Button */}
<div className="relative my-6">
  <div className="absolute inset-0 flex items-center">
    <div className="w-full border-t border-white/10" />
  </div>
  <div className="relative flex justify-center text-xs">
    <span className="bg-[#0a0f1a] px-3 text-white/30">or</span>
  </div>
</div>

<button
  onClick={() => signIn("cognito")}
  className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl
             bg-white/[0.04] border border-white/[0.08] text-white/70
             hover:bg-white/[0.08] transition-all text-sm"
>
  Sign in with SSO
</button>
```

## 제약사항 및 리스크

| 제약사항 | 영향 | 대응 |
|----------|------|------|
| User Pool당 IdP 최대 **25개** | 대부분 충분 (기업당 1-2개 IdP) | 초과 시 별도 User Pool 분리 |
| Lambda 트리거 latency **+50-200ms** | 모든 로그인에 영향 | Provisioned Concurrency, 네이티브 사용자 early-return |
| Federated user **email 충돌** | 동일 email로 네이티브/federated 사용자 공존 시 (Cognito 기본 동작은 별도 사용자 생성) | PreSignUp에서 `AdminLinkProviderForUser`로 계정 연결, 또는 기존 email 발견 시 에러로 충돌 차단 |
| Social IdP **department claim 없음** | 부서 기반 예산/접근제어 불가 | PostAuth Lambda에서 기본 부서 설정, admin 수동 할당 |
| Hosted UI **커스터마이징 제한** | 브랜드 일관성 이슈 | Custom domain + CSS 커스터마이징, 또는 직접 IdP redirect |
| `custom:subdomain` **자동 할당 불가** | Federated 사용자 첫 로그인 시 개발환경 즉시 사용 불가 | Controlled JIT — admin 승인 워크플로우 |
| PreTokenGeneration V2 **응답 형식** | V1과 다른 JSON 구조 | CDK에서 `LambdaVersion.V2_0` 명시 |

## 향후 구현 시 체크리스트

- [ ] CDK config에 `federation` 인터페이스 추가
- [ ] Lambda 트리거 3개 코드 작성 및 테스트
- [ ] `02-security-stack.ts`에 IdP 리소스 + 트리거 추가
- [ ] Login page에 SSO 버튼 추가
- [ ] Admin UI에서 federated 사용자 표시 (`EXTERNAL_PROVIDER` status)
- [ ] Admin UI에서 federated 사용자에게 subdomain 할당 기능
- [ ] IdP 설정 문서 (Azure AD / Okta / KeyCloak 관리자용)
- [ ] E2E 테스트: federated 로그인 → Dashboard → DevEnv 접근
- [ ] 기존 네이티브 사용자 로그인 regression 테스트
