---
status: Accepted
date: 2026-06-23
consolidates: [ADR-022, ADR-028]
---

# 010: 사용자 프로비저닝 (EventBridge pre-provisioning + Cognito JIT fallback)

## Status

Accepted (2026-06-23)

## Context

per-user 신원은 세 평면에 걸쳐 존재한다 — Cognito 레코드 + custom attrs(`custom:subdomain`, `custom:dept_manager_sub`), Local Governance IAM 롤, EC2 DevEnv task 롤 + instance profile. 초기에는 각 평면이 서로 다른 시점·행위자(seed 스크립트 / 대시보드 / 콘솔 / SDK / 첫 로그인 / 첫 인스턴스 start)에 의해 lazy하게 채워졌고, 두 부류의 버그가 따라왔다.

1. **subdomain drift** — 진입점마다 자기만의 subdomain 규칙을 발명해 단일 진실이 없었다.
2. **IAM eventual-consistency race** — `CreateRole→AssumeRole`, `CreateInstanceProfile→RunInstances`를 한 Lambda 호출 안에서 연달아 부르면 전파 지연으로 첫 사용 시 1회성 `AccessDenied`/`InvalidParameterValue`가 발생했다(모든 사용자가 첫 로그인·첫 start에 정확히 한 번씩 hit).

추가로, EventBridge 경로는 **CloudTrail에 cognito-idp API 호출이 기록될 때만** 발화한다. federated(SAML/OIDC) JIT 사용자는 `AdminCreateUser`/`SignUp` 이벤트를 내지 않으므로 이 경로가 영영 발화하지 않아 미프로비저닝 상태로 남는다.

Per-user identity spans three planes (Cognito attrs, Local Governance IAM role, EC2 task role + instance profile). Lazy per-entry-point creation caused subdomain drift and a once-per-user IAM propagation race. The EventBridge path also only fires on a CloudTrail cognito-idp API event, so federated JIT users (no `AdminCreateUser`/`SignUp`) are never provisioned by it.

인증 토폴로지는 004, IAM 롤 계약·boundary·네이밍(subdomain은 005/031 정본 규칙으로 email local-part에서 파생)은 007이 정본이다 — 여기서 재유도하지 않는다.

## Decision

**단일 `user-role-provisioner` Lambda가 사용자 생성의 다운스트림 효과를 소유한다. 주 경로는 CloudTrail→EventBridge pre-provisioning이며, Cognito 트리거 기반 JIT fallback이 federated·누락 사용자를 자가 치유한다.**

**A single `user-role-provisioner` Lambda owns user-creation downstream effects. The primary path is CloudTrail→EventBridge pre-provisioning; a Cognito-trigger JIT fallback self-heals federated and missed users.**

### 주 경로 — EventBridge pre-provisioning

신원을 만드는 모든 진입점은 `AdminCreateUser` + `AdminAddUserToGroup`만 수행하고, 나머지는 프로비저너가 파생한다.

```
AdminCreateUser / SignUp / AdminAddUserToGroup  (cognito-idp)
        ↓  CloudTrail 관리 이벤트
EventBridge rule  →  user-role-provisioner Lambda
   ├─ derive_subdomain(email local-part)        →  custom:subdomain (007/005·031 규칙)
   ├─ ListUsersInGroup(dept-manager)+dept filter →  custom:dept_manager_sub
   ├─ role_factory.ensure_role()                 →  cc-on-bedrock-local-user-{sub}
   └─ _ensure_ec2_task_role()                    →  cc-on-bedrock-task-{subdomain} + instance profile
```

- **CloudTrail PII redaction 대응**: `userAttributes`/username은 `HIDDEN_DUE_TO_SECURITY_REASONS`로 가려지지만 `sub`는 `additionalEventData.sub`(AdminCreateUser) / `responseElements.userSub`(SignUp)에 남는다. 프로비저너는 `sub`를 추출 후 `AdminGetUser`로 email+attrs를 재조회한다.
- **dept_manager_sub 의미**: 매니저 = `custom:department`가 일치하는 `dept-manager` 그룹의 첫 멤버(자기 자신 self-point). 그룹 승격/강등 시 같은 부서 전원 갱신. 매니저 정체성은 email에 인코딩되지 않아 email 회전 없이 승격/강등 가능.
- **공유 헬퍼** `lambda/role_factory.py`가 trust/inline policy + `ensure_role()`를 `sts-issuer.py`에서 분리 — per-user IAM 계약의 단일 정본. 두 Lambda가 직접 import.
- **direct-invoke 계약** `{"action":"ensure","sub":...}` — backfill/수동 복구용. EventBridge 경로와 동일 파이프라인(behavioral parity).
- 모든 ensure 단계는 idempotent(`get_role` exists-branch; orphan instance profile은 재부착).

### Fallback 경로 — Cognito 트리거 JIT (federated 대응)

PostAuthentication에 얇은 shim Lambda를 연결한다. shim은 `event.request.userAttributes.custom:subdomain`이 이미 있으면 즉시 통과(no-op, 로그인 지연 ~0)하고, 없을 때만 `user-role-provisioner`를 **비동기**(`InvocationType=Event`)로 direct-invoke 계약으로 호출한 뒤 이벤트를 그대로 반환한다.

- shim은 pool export가 아닌 **정적 함수 이름 문자열**로 프로비저너를 참조 → Stack 08과 순환 의존 없음.
- **fail-open**: 예외는 무시하고 이벤트 반환 → 로그인 가용성 보장(Cognito 트리거 5초 타임아웃·에러 시 인증 실패 회피).
- 동일 ADR-022 파이프라인 재사용 — 프로비저닝 분기 없음.

### Defense-in-depth

`sts-issuer.py`는 `role_factory.ensure_role`를 import하는 lazy fallback을 유지(retry 6회/31s). EventBridge가 dark이거나 trail 부재 계정에서도 Local Governance를 즉시 커버한다.

## Consequences

**Positive**
- per-user 신원의 단일 정본 — seed/대시보드/콘솔/SDK 간 drift 제거.
- 첫 로그인·첫 인스턴스 start의 IAM race 제거(둘 다 exists-branch hit).
- federated JIT 사용자가 첫 로그인 시 자동 프로비저닝 — IdP 연동만 하면 무설정. 과거 누락 사용자도 PostAuthentication 백스톱으로 자가 치유.
- 모든 프로비저닝 단계가 CloudWatch에 sub/email/dept/생성물과 함께 기록.

**Negative / trade-offs**
- Lambda + EventBridge rule + Cognito 트리거가 Stack 08에 추가(≈ $0/월 규모; $1/M invocations). Stack 08은 `AdminGetUser`/`AdminUpdateUserAttributes`/`ListUsersInGroup` grant를 위해 `userPool`을 props로 받는다.
- CloudTrail 관리 이벤트 → EventBridge 전달이 계정에 활성화돼야 주 경로가 동작. 부재 시 fallback/STS Issuer가 부하를 진다(EC2 모드는 JIT 윈도우 동안 race 가능).
- 첫 로그인 직후 ~수 초 미프로비저닝 윈도우 — 그 사이 인스턴스 start 시 "No subdomain assigned" 1회 가능(STS Issuer fallback + EC2 재시도로 해소).

**Out of scope (follow-ups)**
- attribute 키 외부화(SSM)로 SAML/OIDC 스키마 매핑.
- 대시보드 `/api/users` POST의 잉여 `subdomain` 필드 제거(프로비저너가 파생하므로 불필요).
- 삭제 시 다운스트림 cleanup은 004(`AdminDeleteUser` → `_deprovision_user`)가 정본.
- Cognito `list-users` custom-attr Filter 미지원으로 client-side scan — 수천 사용자 규모까지 허용.

## Files

- `lambda/role_factory.py` — 공유 IAM 헬퍼(단일 정본)
- `lambda/user-role-provisioner.py` — EventBridge + direct-invoke Lambda
- `lambda/sts-issuer.py` — role_factory import, defense-in-depth retry
- `lambda/cognito-provisioner-shim.py` — PostAuthentication JIT fallback shim
- `terraform/modules/security/main.tf` — user pool schema + Cognito 트리거 배선
- `terraform/modules/local-governance/main.tf` — provisioner Lambda + IAM + EventBridge rule
- `shared/nextjs-app/src/lib/ec2-clients.ts` — duplicate-tag fix + `runInstancesWithIamRetry`
- `scripts/backfill-local-user-roles.sh` — direct-invoke backfill helper

## Consolidates

이 ADR은 다음 레거시 ADR을 통합·대체한다. 원문은 git tag `adr-legacy-2026-06-23`에 보존되며 `docs/history/ADR-MAPPING.md`에 매핑된다. 통합된 번호는 재사용하지 않는다.

- **ADR-022** — EventBridge pre-provisioning of per-user identity (IAM + Cognito attrs)
- **ADR-028** — Cognito trigger fallback provisioning (federated JIT 사용자 대응)
