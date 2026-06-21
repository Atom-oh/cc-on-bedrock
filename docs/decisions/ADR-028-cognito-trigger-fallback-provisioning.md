---
status: Accepted
date: 2026-06-11
verification_required: true
builds_on: ADR-022
---

# ADR-028: Cognito 트리거 기반 프로비저닝 fallback (federated JIT 사용자 대응)

**Status:** Accepted (구현 pending)
**Date:** 2026-06-11
**Builds on:** [ADR-022 EventBridge pre-provisioning of per-user identity](ADR-022-eventbridge-role-preprovisioning.md) · 관련 [ADR-024 Cognito user deletion → downstream cleanup](ADR-024-cognito-deletion-cleanup.md)

## 배경

ADR-022는 `user-role-provisioner` Lambda를 per-user identity(Cognito custom attrs +
IAM roles)의 single source of truth로 만들었습니다. 트리거 경로는
**CloudTrail → EventBridge** 입니다:

```
AdminCreateUser / SignUp / AdminAddUserToGroup (cognito-idp API 호출)
  → CloudTrail 관리 이벤트
  → EventBridge rule (cc-on-bedrock-cognito-user-created)
  → user-role-provisioner
```

이 경로는 **API 호출이 존재할 때만** 동작합니다. 검증 결과 콘솔/대시보드/SDK 생성
사용자에 대해서는 정상 동작함을 확인했습니다 (2026-06-11, `psungbum` 사용자 —
AdminCreateUser 이벤트로 프로비저너 발화, subdomain/attrs/IAM 모두 생성됨).

문제는 **SAML/OIDC federation(AD/Okta 등)으로 들어오는 JIT(Just-In-Time) 생성
사용자**입니다. Federated 사용자가 첫 SSO 로그인을 하면 Cognito가 내부적으로
사용자 레코드를 생성하는데, 이때 `AdminCreateUser`/`SignUp` API가 호출되지
않으므로 CloudTrail 이벤트가 없고 EventBridge rule이 발화하지 않습니다. 결과:
사용자는 Cognito에 존재하지만 `custom:subdomain`이 비어 있어 프로비저닝이
거부되고("No subdomain assigned"), per-user IAM role도 사전 생성되지 않습니다.

Federation 연동 자체(IdP 설정, attribute mapping)는 회사마다 달라 이 프로젝트의
스콥이 아닙니다(사용자 결정). 그러나 이 플랫폼을 가져다 쓰는 조직은 대부분
federation을 사용할 것으로 예상되므로, **"Cognito에 사용자가 존재하게 된 이후"는
경로 불문 전부 자동**이어야 합니다.

### Cognito Lambda 트리거 제약 (공식 문서 확인, 2026-06-11)

Federated 사용자에 대해 발화하는 user pool Lambda 트리거:

| 시점 | 트리거 (trigger source) |
|---|---|
| 첫 로그인 (JIT 생성) | Pre sign-up (`PreSignUp_ExternalProvider`), Post confirmation (`PostConfirmation_ConfirmSignUp`), Pre token generation (`TokenGeneration_HostedAuth`) |
| 이후 로그인 | Pre authentication, Post authentication (`PostAuthentication_Authentication`), Pre token generation |

운영상 제약:

- 트리거는 **동기 호출, 5초 하드 타임아웃** (변경 불가)
- 트리거 함수가 에러를 반환하면 **해당 인증 이벤트(로그인) 자체가 실패**
- Pre token generation은 토큰 claim만 수정 가능 — attribute 쓰기 불가

따라서 ADR-022 파이프라인(IAM 생성 + ListUsersInGroup 등, 수 초 소요 가능)을
트리거 안에서 직접 실행하는 것은 부적합합니다.

## 검토한 옵션

### 옵션 1: Cognito 트리거 shim → 프로비저너 비동기 invoke (채택)

PostConfirmation + PostAuthentication에 얇은 shim Lambda를 연결. shim은
`event.request.userAttributes`에 `custom:subdomain`이 이미 있으면 즉시 통과시키고,
없을 때만 `user-role-provisioner`를 **비동기(`InvocationType=Event`)** 로
direct-invoke 계약(`{"action":"ensure","sub":...}`, ADR-022 §6)으로 호출한 뒤
이벤트를 그대로 반환.

- **장점**: JIT 생성 순간(PostConfirmation) + 모든 이후 로그인(PostAuthentication)
  이중 커버 → 누락 사용자 자가 치유. 기존 파이프라인 재사용(behavioral parity).
  이미 프로비저닝된 사용자는 attribute 검사만으로 no-op(로그인 지연 ~0).
  fail-open(예외 무시 + 이벤트 반환)으로 로그인 가용성 보장.
- **단점**: 첫 로그인 직후 수 초간 프로비저닝 미완료 윈도우 존재(아래 영향 참조).
  Lambda 1개 추가.

### 옵션 2: 트리거 안에서 프로비저닝 인라인 실행

- **장점**: 첫 로그인 완료 시점에 프로비저닝도 완료(윈도우 없음).
- **단점**: 5초 타임아웃 초과 위험(IAM propagation 포함 시 상시), 프로비저너
  버그/스로틀이 곧바로 **전사 로그인 장애**가 됨. 기각.

### 옵션 3: 주기적 reconciliation sweep (EventBridge cron)

`ListUsers`로 `custom:subdomain` 없는 사용자를 찾아 ensure 일괄 실행.

- **장점**: 트리거 의존성 제로, 어떤 누락 경로든 커버.
- **단점**: 프로비저닝 지연이 cron 주기(분~시간 단위)만큼 발생 — 첫 로그인 직후
  인스턴스 생성하려는 사용자 경험 나쁨. 단독으로는 부족하나 옵션 1의 보완책으로는
  유효(후속 과제).

## 결정

**옵션 1.** 구현 형상:

```
cdk/lib/lambda/cognito-provisioner-trigger.py   (신규 shim, Stack 02)
  - triggerSource 무관 동일 로직:
      custom:subdomain 존재 → return event        (no-op, 지연 없음)
      부재 → lambda:Invoke(Event) user-role-provisioner {"action":"ensure","sub":...}
             → return event
  - 전체 try/except: 어떤 실패도 로그인을 막지 않음 (fail-open)

cdk/lib/02-security-stack.ts
  - userPool.addTrigger(POST_CONFIRMATION, shim)
  - userPool.addTrigger(POST_AUTHENTICATION, shim)
  - shim → 프로비저너 참조는 정적 함수 이름
    ("cc-on-bedrock-user-role-provisioner") ARN 문자열로 IAM grant —
    cross-stack export 금지 규칙 준수. Stack 08 미배포 환경에서는 invoke 실패가
    shim에서 잡혀 로그만 남고 로그인은 정상 진행.
```

shim을 Stack 02에 두는 이유: `addTrigger`는 UserPool 리소스를 변경하므로 소유
스택(02)에서만 호출 가능. Stack 08(프로비저너)을 02가 참조하면 기존 02→08 의존
방향과 순환하므로, 함수 이름 문자열 참조로 디커플링.

## 영향

### 긍정적

- Federation JIT 사용자가 첫 로그인 직후 자동 프로비저닝됨 — IdP 연동만 하면
  나머지는 무설정.
- PostAuthentication 백스톱 덕분에 과거 누락 사용자(EventBridge 장애, trail 부재
  계정 등)도 다음 로그인 한 번으로 자가 치유.
- ADR-022 파이프라인 단일 유지 — 프로비저닝 로직 분기 없음.

### 부정적 / 트레이드오프

- 첫 로그인 ~수 초간 미프로비저닝 윈도우: 그 사이 인스턴스 start를 시도하면
  "No subdomain assigned" 1회 발생 가능. STS Issuer의 lazy fallback(ADR-022 §7)이
  Local Governance 경로는 즉시 커버하며, EC2 경로는 재시도로 해소. UI에서
  프로비저닝 중 안내를 추가하면 완화 가능(후속).
- Cognito 트리거가 user pool 설정에 추가됨 — 트리거 Lambda 삭제 시 user pool
  설정도 함께 해제해야 함(미해제 시 로그인 영향 없음: fail-open이 아니라 Cognito가
  함수 부재 시 에러를 내므로 **반드시 CDK로 수명주기 일치 관리**).
- PreSignUp auto-confirm은 다루지 않음 — federated 사용자는 Cognito가 자동
  confirm하므로 불필요.

## 운영 검증 계획 (수동)

1. `governanceOnly` 포함 배포에서 PostConfirmation/PostAuthentication 트리거가
   user pool에 연결되는지 `aws cognito-idp describe-user-pool` 로 확인.
2. custom:subdomain 없는 테스트 사용자 생성(attribute 수동 삭제) → 로그인 →
   수 초 내 subdomain/IAM 생성 확인 (`user-role-provisioner` 로그).
3. Stack 08 미배포 상태에서 로그인이 실패하지 않는지 확인 (shim fail-open).
4. 이미 프로비저닝된 사용자 로그인 시 프로비저너 invoke가 발생하지 않는지 확인
   (shim no-op 경로, CloudWatch 메트릭).

## Verification

```yaml
# Tier 1: Static
files:
  - path: lambda/cognito-provisioner-trigger.py
    must_exist: true
    must_contain:
      - "custom:subdomain"
      - "InvocationType"
      - "cc-on-bedrock-user-role-provisioner"
  - path: terraform/modules/security/main.tf
    must_contain:
      - "post_confirmation"
      - "post_authentication"
      - "cognito-provisioner-trigger"

# Tier 2: Semantic
semantic:
  - claim: "shim 트리거는 custom:subdomain attribute가 이미 존재하면 프로비저너를 invoke하지 않고 이벤트를 그대로 반환한다 (no-op fast path)"
    context_files:
      - cdk/lib/lambda/cognito-provisioner-trigger.py
  - claim: "shim 트리거는 프로비저너를 InvocationType=Event(비동기)로 호출하며, 어떤 예외가 발생해도 이벤트를 반환하여 로그인을 실패시키지 않는다 (fail-open, Cognito 5초 동기 타임아웃 대응)"
    context_files:
      - cdk/lib/lambda/cognito-provisioner-trigger.py
  - claim: "Stack 02는 프로비저너를 cross-stack export가 아닌 정적 함수 이름 문자열로 참조하여 Stack 08과의 순환 의존을 만들지 않는다"
    context_files:
      - cdk/lib/02-security-stack.ts
```

## 참고 자료

- [Customizing user pool workflows with Lambda triggers — Lambda triggers for federated users](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-working-with-lambda-triggers.html) (federated trigger source 표, 5초 타임아웃, 에러 시 인증 실패)
- ADR-022 §6 direct-invoke 계약: `cdk/lib/lambda/user-role-provisioner.py` (`{"action":"ensure","sub":...}`)
- 검증 로그: `psungbum` AdminCreateUser 경로 정상 동작 확인 (2026-06-11, provisioner CloudWatch log)
