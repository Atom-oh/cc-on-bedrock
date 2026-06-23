---
status: Accepted
date: 2026-06-23
consolidates: [ADR-024, ADR-012]
---

# 004: 인증 (Cognito + NextAuth · 사용자 삭제 cleanup)

## Status

Accepted (2026-06-23)

## Context

플랫폼은 단일 Amazon Cognito User Pool로 대시보드와 per-user DevEnv 양쪽의 신원을 통제한다. 두 가지 문제가 결정을 요구했다.

1. **DevEnv 인증 진화.** 초기 설계(레거시 ADR-012)는 `*.dev` DevEnv 경로를 **Lambda@Edge(Viewer Request) + Nginx 서브도메인 검증**으로 보호하고, DevEnv 전용 별도 Cognito UserPoolClient·HMAC 서명 쿠키를 두었다. 이 모델은 통합 CloudFront/NextAuth 모델(레거시 ADR-013→016, 현 003·005)로 대체되어 Lambda@Edge 인증·DevEnv 전용 클라이언트·HMAC 쿠키는 폐기됐다.
2. **사용자 라이프사이클 비대칭.** 프로비저닝(현 010)은 신원 생성만 다뤘고 삭제는 미배선이었다. Cognito 사용자를 수동 삭제하면 IAM 롤·instance profile·실행 중 EC2·DDB 행·Secret·limits 행이 고아로 남아 비용·보안 부채가 누적됐다. 또한 대시보드 `/admin`의 "Permanent Delete" 버튼은 federated(SAML/OIDC) 사용자를 하드 삭제해 재동기화를 깨뜨릴 위험이 있었다.

The platform governs both the dashboard and per-user DevEnv identities through a single Cognito User Pool. The legacy Lambda@Edge DevEnv auth (separate UserPoolClient + HMAC-signed cookie + Nginx subdomain enforcement) was superseded by the unified CloudFront/NextAuth model. Separately, deletion was not symmetric to provisioning, leaving orphaned downstream resources, and the dashboard could hard-delete federated users.

신원 토폴로지·라우팅 상세는 003, 프로비저닝(JIT 포함)은 010, 사용량 키(email canonical)는 005가 정본이다 — 여기서 재유도하지 않는다.

## Decision

**Cognito User Pool + public client(NextAuth.js) 단일 인증, 사용자 삭제 시 다운스트림 cleanup을 프로비저닝과 대칭으로 수행한다.**

**Cognito User Pool + a public client driven by NextAuth.js; user deletion fans out downstream cleanup symmetrically to provisioning.**

### 인증 모델 / Auth model

- 공통 Cognito User Pool을 신원 정본으로 두되 **클라이언트는 2종으로 분리**한다: (1) **Dashboard = confidential client** — NextAuth.js가 처리하며 **client secret 사용**(SSM `/cc-on-bedrock/cognito/client-secret`에 보관, 부팅 시 주입); (2) **Local CLI(`cc-bedrock-local`) = public client** — secret 없이 PKCE 코드 플로우(006). client-secret을 SSM에 정본으로 유지하는 이유는 (1) Dashboard confidential client 때문이다(CLAUDE.md와 일치).
- DevEnv 접근 인가는 통합 CloudFront/NextAuth 경로로 처리한다(003). **레거시 Lambda@Edge 인증 람다·DevEnv 전용 UserPoolClient·HMAC 쿠키는 제거**됐다.
- Cognito 자격증명(client-id 등)은 SSM Parameter Store에서 부팅 시 주입한다(하드코딩 금지).

### 삭제 → 다운스트림 cleanup / Deletion handler

`AdminDeleteUser`를 프로비저너의 EventBridge 트리거에 추가하고, 동일 Lambda에 역방향 `_deprovision_user` 경로를 둔다. 생성과 삭제는 같은 Lambda·반대 방향이다.

```
AdminDeleteUser → CloudTrail → EventBridge → user-role-provisioner → _deprovision_user
   ├─ local-user 롤 태그(email/subdomain)에서 식별자 복구 → derive_subdomain (stateless)
   ├─ EC2 terminate (tag subdomain=… AND managed_by=cc-on-bedrock)
   ├─ task 롤 + instance profile 삭제 (cc-on-bedrock-task-{subdomain})
   ├─ 데이터 EBS DeleteVolume (cc-user-volumes의 dataVolumeId/dataVolumeAz로 식별 → detach→available → 선택적 최종 snapshot → 삭제). AdminDeleteUser = ADR-032 rule 9의 "admin 완전 삭제" 경로이므로 데이터 볼륨도 삭제 (FAQ와 일치). **반드시 dataVolumeId가 담긴 DDB 행 삭제보다 먼저** 수행해 고아·재연결 가능 볼륨 방지
   ├─ DDB 행 삭제 (cc-user-instances / cc-user-volumes / cc-routing-table) — 데이터 볼륨 삭제 후
   ├─ codeserver Secret force-delete (cc-on-bedrock/codeserver/{subdomain})
   ├─ local-user 롤 삭제 (cc-on-bedrock-local-user-{subdomain})
   └─ limits 행 삭제 (PK=USER#{email})
```

- 각 step은 멱등(NoSuchEntity/ResourceNotFound 흡수)하고, partial failure 시 RuntimeError로 EventBridge 재시도를 유발한다. local-user 롤은 식별자 복구원이므로 모든 step 성공 시에만 마지막에 삭제한다. 직접 호출 계약 `{"action":"deprovision","sub":"…"}`으로 수동 복구 가능.
- 키 표기는 005(email canonical) 기준: 삭제 대상은 `cc-on-bedrock-local-user-{subdomain}` 롤·`USER#{email}` limits 행. cleanup은 롤 태그에서 식별자를 복구하므로 절차는 키 변경과 무관하게 유효하다.

### 대시보드 하드 삭제 차단 / Federation-safe delete

- `/api/users` DELETE의 `action=permanent`는 **HTTP 403** + 안내 메시지를 반환하고, UI의 "Delete" 버튼·`handlePermanentDelete` 핸들러는 제거됐다. 남는 작업은 **Disable**(기본 권한 회수, federation-safe)·**Enable**·**Reset Env**(soft delete)다.
- Cognito 하드 삭제는 federated 여부를 사람이 확인한 뒤 AWS Console/CLI로만 수행한다. 그 경우에도 AdminDeleteUser 이벤트가 발화해 프로비저너가 정리한다.

### 기본 그룹 fallback / Default group

- Console/SAML/OIDC로 생성돼 그룹이 없는 사용자는 미들웨어가 거부하므로, `_provision_user` 말미에 `_ensure_default_group`을 두어 그룹이 비면 `user`로 추가한다(seed 경로는 no-op). admin 승격은 여전히 명시적 `admin-add-user-to-group` 필요.

> federated/Console JIT 사용자에 대한 프로비저닝 트리거(Cognito 트리거 기반 fallback, 레거시 ADR-028)는 **010(프로비저닝)** 정본이다. 본 ADR은 인증·삭제만 다룬다.

## Consequences

긍정 / Positive
- 라이프사이클 대칭: 생성 fan-out = 삭제 fan-out. 수동 삭제도 고아 리소스 없이 안전.
- Federation-safe: 대시보드가 federated 사용자를 실수로 하드 삭제 못 함.
- Console 생성 사용자도 즉시 로그인(기본 그룹 자동 부여).
- 인증 표면 단순화: Lambda@Edge·HMAC 쿠키·DevEnv 전용 클라이언트 제거.

부정·위험 / Negative & risk
- 프로비저너 Lambda blast radius 확대(IAM/DDB/Secrets/EC2 삭제 권한) — ARN prefix + `managed_by` 태그 조건으로 완화.
- 삭제 시 EC2 무조건 terminate → 미저장 작업 손실 가능(운영 경고, 코드 미완화).
- **TerminateInstances vs DeleteRole 경합**: terminate는 async라 instance가 `terminated` 도달 전엔 instance profile 참조 해제 안 됨 → `_safe_delete_*`가 DeleteConflict 흡수, 완전 종료 후 재호출로 마무리(known partial-completion).
- 기본 그룹 `user` 가정 — IdP claim→group 매핑은 follow-up(010 config 트랙).

보안 / Security
- public client는 client secret 부재 → PKCE 등 코드 플로우 보호에 의존(NextAuth 처리). 인가 경계는 Cognito 그룹 + 미들웨어.
- 하드 삭제는 사람-게이트(Console/CLI)로만 허용, 대시보드는 disable만.

## Consolidates

- **ADR-024** (Cognito user deletion → downstream cleanup)
- **ADR-012** (DevEnv Cognito auth via Lambda@Edge — superseded; archived)

Cognito JIT 트리거 프로비저닝(레거시 ADR-028)은 **010**에 통합됨(중복 금지, 교차참조). Local Mode 자격증명은 **006** 참조.

레거시 ADR 본문은 트리에서 제거되었고 git tag `adr-legacy-2026-06-23` + `../history/ADR-MAPPING.md`에 보존된다. 번호 재사용 금지.
Legacy bodies live in git tag `adr-legacy-2026-06-23` and `../history/ADR-MAPPING.md`.

## Verification

```yaml
# Tier 1: Static
files:
  - path: lambda/user-role-provisioner.py
    must_contain:
      - "AdminDeleteUser"
      - "_deprovision_user"
      - "_ensure_default_group"
  - path: shared/nextjs-app/src/app/api/users/route.ts
    must_contain:
      - "403"
    must_not_contain:
      - "handlePermanentDelete"

# Tier 2: Semantic
semantic:
  - claim: "AdminDeleteUser 이벤트 시 프로비저너가 IAM role + instance profile + DDB rows + Secrets + EC2를 멱등하게 정리하고, local-user 롤은 식별자 복구원이므로 모든 step 성공 시에만 마지막에 삭제한다"
    context_files:
      - lambda/user-role-provisioner.py
  - claim: "대시보드 /api/users DELETE의 action=permanent는 403을 반환하고 하드 삭제 UI는 제거되어 federated 사용자를 보호한다"
    context_files:
      - shared/nextjs-app/src/app/api/users/route.ts
```
