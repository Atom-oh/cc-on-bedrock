# ADR-016: Separate CloudFront Distributions per Concern

## Status
Accepted (2026-05-12) — supersedes [ADR-013](ADR-013-unified-cloudfront-auth.md). Split implemented (DevenvCf in Stack 04, DashboardCf in Stack 05); `cdk/lib/lambda/devenv-origin-router/` archived per Migration Plan Step 4.

## Context

ADR-013은 Dashboard와 DevEnv를 단일 CloudFront distribution 뒤에 두고 Lambda@Edge `viewer-request`(session-validator)와 `origin-request`(origin-router)로 host 기반 분기 라우팅을 도입했다. NextAuth 세션 쿠키를 `.atomai.click`으로 공유해 두 표면이 같은 인증을 사용하는 구조다.

운영하며 두 가지 문제가 누적되었다:

1. **ACM wildcard cert 깊이 제약** — Dashboard CloudFront의 cert(`*.atomai.click`)는 1단계 wildcard만 cover하므로 `cconbedrock-dashboard.atomai.click`은 OK이지만 `*.dev.atomai.click` SAN 추가가 실패한다 (`InvalidRequest: The certificate doesn't cover the alternate domain name`). 두 도메인을 cover하려면 두 도메인을 모두 SAN으로 갖는 단일 cert를 새로 발급해야 한다. 실제로 2026-04-17 `CcOnBedrock-Dashboard` 업데이트가 이 에러로 롤백되었고 현재까지 `UPDATE_ROLLBACK_COMPLETE` 상태로 멈춰 있다.

2. **Stack 04 ↔ Stack 05 강결합** — 통합 distribution이 Stack 05에 있으므로 Stack 05가 NLB DNS(`cdk.Fn.importValue('cc-devenv-nlb-dns')`)와 SG 3종(`sgOpen/Restricted/Locked`)을 synth-time에 참조한다. 이 결합 때문에 ADR-014 Local Governance Mode의 `governanceOnly=true` 옵션이 Stack 04(ECS DevEnv)를 skip할 수 없다.

두 문제 모두 통합 구조 자체에서 파생된다.

## Decision

**도메인별 책임이 분리된 두 개의 CloudFront distribution으로 회귀한다.** Lambda@Edge session-validator는 양 distribution에서 동일 함수를 공유하므로 인증 로직 중복은 없다.

```
Dashboard CloudFront (Stack 05)
  ├─ alias: cconbedrock-dashboard.atomai.click
  ├─ cert : *.atomai.click  (기존 발급분 그대로)
  ├─ origin: ALB → Dashboard ECS Ec2Service
  └─ edge: session-validator (viewer-request)

DevEnv CloudFront (Stack 04로 이관)
  ├─ alias: *.dev.atomai.click
  ├─ cert : *.dev.atomai.click  (이미 ACM에 존재: 85c9ded8-...)
  ├─ origin: NLB → Nginx (per-user routing)
  └─ edge: session-validator (viewer-request) — 동일 EdgeFunction 객체 참조
```

`origin-request` 라우터는 호스트 분기가 불필요해지므로 제거한다.

### Rationale

| Dimension | 통합 CF (ADR-013) | 분리 CF (ADR-016) |
|-----------|------------------|------------------|
| Cert 관리 | 두 도메인 cover하는 SAN cert 필요 (재발급) | 도메인별 기존 cert 그대로 사용 |
| Stack 결합 | Stack 05가 04의 NLB/SG를 참조 | 결합 없음 |
| `governanceOnly` | Stack 04 skip 불가 | Stack 04 자체를 skip 가능 |
| Lambda@Edge | viewer + origin 두 함수 | viewer만 (한 함수 공유) |
| 비용 | distribution 1개 | distribution 2개 — request/transfer 종량제라 실비용 차이 거의 0 |
| 세션 공유 | 같은 distribution, 자동 | `.atomai.click` 쿠키 도메인으로 동일하게 동작 |
| 운영 복잡도 | 라우팅 함수가 SPOF, 변경 시 edge propagation 영향 큼 | 도메인 단위 변경이 격리됨 |

핵심 판단: ADR-013이 노린 "통합 인증" 효과는 **쿠키 도메인 `.atomai.click`만으로 달성**된다. distribution이 두 개여도 NextAuth 세션 쿠키는 양쪽에서 그대로 읽힌다. 통합 distribution이 가져온 이득은 사실상 "관리 표면 하나"인데, cert wildcard 깊이 제약과 stack 결합이라는 두 부작용이 그 이득을 압도한다.

## Architecture

### Lambda@Edge 공유

session-validator는 us-east-1 EdgeFunction으로 한 번 정의하고, 두 distribution 모두 `currentVersion`을 참조한다. CDK 객체로 cross-stack 공유가 어려우면 함수 ARN/Version을 SSM Parameter(Store)에 저장하고 두 stack이 SSM에서 import한다.

```ts
// Stack 05 (Dashboard CF):
const sessionValidator = new cloudfront.experimental.EdgeFunction(
  this, 'SessionValidator', { ... });
new ssm.StringParameter(this, 'SessionValidatorVersionArn', {
  parameterName: '/cc-on-bedrock/session-validator-version-arn',
  stringValue: sessionValidator.currentVersion.edgeArn,
});

// Stack 04 (DevEnv CF):
const validatorArn = ssm.StringParameter.valueForStringParameter(
  this, '/cc-on-bedrock/session-validator-version-arn');
// CfnDistribution.LambdaFunctionAssociation 으로 raw ARN 참조
```

또는 함수를 한 번만 정의하는 별도 작은 stack(`05a-edge-functions`)에 두는 안도 가능. 결정은 구현 PR에서.

### Origin Router 제거

기존 `devenv-origin-router/index.js`는 NLB DNS와 CF secret을 SSM에서 읽어 호스트별 분기했다. 분리 후에는 DevEnv CF가 직접 NLB origin을 갖고, Dashboard CF가 직접 ALB origin을 갖는다. 라우터 자체가 불필요.

### Route 53

- 기존: 한 distribution에 두 record alias
- 분리 후: `cconbedrock-dashboard.atomai.click` → Dashboard CF, `*.dev.atomai.click` → DevEnv CF

### Cert 사용

- Dashboard CF: `*.atomai.click` (기존, dashboardCertificateArn context)
- DevEnv CF: `*.dev.atomai.click` (기존 `85c9ded8-bab1-4cf0-9a5e-2a8d79b302b8`, 새 context `devenvCertArn`)
- `unifiedCertArn` context는 폐기

### WAF

기존 `WafStack`의 WebACL ARN을 두 distribution이 모두 참조 (Web ACL은 여러 CF에 attach 가능).

## Changes

### CDK 코드
- **Stack 05 (Dashboard)**: DashboardStackProps에서 `sgOpen/sgRestricted/sgLocked/nlbDnsName` 제거. CloudFront aliases는 dashboard 도메인만. `OriginRouterConfigParam` SSM 제거. `originRouterFn` Lambda@Edge 제거. session-validator Lambda@Edge는 그대로 유지하고 currentVersion ARN을 SSM으로 export.
- **Stack 04 (DevEnv)**: 신규 CloudFront distribution(NLB origin + session-validator edge function 참조) + Route 53 `*.dev` record. context로 `devenvCertArn` 입력. 기존 NLB 통과 secret(X-Custom-Secret) 보안 헤더는 그대로 사용.
- **`bin/app.ts`**: `unifiedCertArn` context 제거(deprecation OK). `dashboardCertArn`, `devenvCertArn` 두 context. `governanceOnly=true`일 때 Stack 04 instantiation 완전 skip. Stack 05 props에 Stack 04 의존 제거.

### Dashboard Next.js
- `STORAGE_TYPE=ec2` 모드의 EC2 생성 라우트는 `governanceOnly` 시 비활성화 (이미 sidebar 분기 있음, 페이지/API 레벨 가드 추가 — ADR-014 후속)

### 문서
- ADR-013 status → "Superseded by ADR-016"
- `docs/architecture.md` 그림 업데이트
- `cdk/CLAUDE.md` Stack 04/05 책임 재기술
- `docs/deployment-guide.md` cert 발급/지정 절차에서 unifiedCert 단락 제거

### Lambda@Edge
- `devenv-origin-router/` 디렉토리 삭제 또는 archive
- `devenv-session-validator/` 그대로 유지 (cross-region replication 동일)

### 미마이그레이션 — Cookie 도메인
- 기존 NextAuth 설정 `COOKIE_DOMAIN=.atomai.click` 유지. 분리 후에도 두 distribution 모두 같은 쿠키를 본다.

## Migration Plan (cutover)

CloudFormation export 제거 + CloudFront 도메인 이전이 동시 deploy로 가능한지 stack dependency를 보고 단계로 쪼갠다.

1. **Step 1 — DevEnv CF 신규 생성 (병행 운영)**
   - Stack 04에 신규 DevEnv CF 추가. 기존 통합 CF의 `*.dev` 동작은 그대로 유지.
   - Route 53는 아직 통합 CF를 가리킴 (`*.dev` record 변경 금지).
   - Deploy → 신규 CF가 Deployed 상태가 되기까지 약 5분.

2. **Step 2 — DNS 전환**
   - Route 53 `*.dev.atomai.click` alias를 신규 DevEnv CF로 변경 (TTL 60s).
   - 5분간 양쪽 트래픽 공존. 신규 CF로 트래픽 이동 확인.

3. **Step 3 — Dashboard CF에서 DevEnv 동작 제거**
   - Stack 05 deploy: aliases에서 `*.dev.atomai.click` 제거, originRouter Lambda@Edge 연결 해제, originRouter 함수 삭제는 마지막 단계.
   - Lambda@Edge 연결 해제는 edge replication 완료까지 ~15분 소요.

4. **Step 4 — 코드 정리**
   - originRouter Lambda 함수, SSM `/cc-on-bedrock/devenv-origin-config` 삭제.
   - Stack 05의 NLB/SG/ecsInfrastructureRole 입력 prop 제거.
   - DashboardStackProps 타입 축소 commit.

5. **Step 5 — Network rollback 별건 정리**
   - `DnsFirewallRuleGroup` managed domain list 참조 방식 fix는 ADR-016과 무관하지만 이 PR에 포함해 동시에 해소 권장(같은 deploy 사이클).

## Consequences

### Positive
- Cert 발급/관리가 도메인 단위로 정상화
- Stack 04 ↔ 05 결합 해제 → ADR-014 `governanceOnly` 옵션이 실제로 EC2/ECS 인프라를 끄게 됨
- Lambda@Edge origin-router 1개 사라짐 (운영 표면 감소, propagation 영향 면적 축소)
- Distribution 단위로 캐시/WAF/배포 변경을 격리 가능

### Negative
- CloudFront distribution이 1개 → 2개. 빌링 거의 동일하지만 운영 대시보드/지표가 두 군데로 분산
- session-validator Lambda@Edge 함수를 두 distribution에서 참조 → 함수 변경 시 양쪽 propagation 모두 기다려야 함
- ADR-013 supersede 처리 + 관련 다이어그램/문서 6-7개 동기 업데이트 필요

### Out of Scope
- 통합 인증 외의 다른 ADR-013 의도(예: cookie 공유 메커니즘 단순화)는 분리 후에도 그대로 작동
- `dev.atomai.click` 외 다른 sub-platform 도메인을 추가하는 경우는 별도 검토

## References
- ADR-013: Unified Dashboard + DevEnv CloudFront (this ADR supersedes)
- ADR-014: Local Governance Mode (depends on Stack 04 ↔ 05 decoupling)
- AWS docs: ACM wildcard certs do not cover sub-sub-domains
- CloudFront Lambda@Edge replication: ~5-15 min after function version change
