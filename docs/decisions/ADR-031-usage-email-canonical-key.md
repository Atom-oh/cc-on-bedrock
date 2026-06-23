---
status: Accepted
verification_required: true
---

# ADR-031: usage/limits canonical key = email, IAM role name = subdomain, Cognito sub eliminated (supersedes ADR-025)

## Status
Accepted — **supersedes [ADR-025](archive/ADR-025-usage-pipeline-canonical-identifier.md)** (canonical = Cognito sub).

## Context
ADR-025는 canonical 사용자 키를 Cognito sub(UUID)로 정했다. 운영 중 진단(2026-06-12) 결과:
- usage 트래커 EC2 경로의 `_resolve_sub_from_subdomain`이 `Filter='custom:subdomain=...'`를 쓰는데 **Cognito ListUsers는 custom 속성 필터 미지원** → 항상 실패 → `USER#{subdomain}` fallback. Local 경로만 `USER#{sub}`.
- 결과: 동일인이 `USER#{subdomain}` + `USER#{sub}` 두 행으로 분할(대시보드 이중집계), 그리고 `token-limit-enforcer`가 PK=sub를 가정해 `USER#{subdomain}` 사용량을 **존재하지 않는 한도에 조회 → 집행 누락(우회)**.
- UUID는 대시보드 가독성도 나쁘다.

조직 정책상 **이메일은 사용자별 고유·재직 중 불변**(퇴사까지) — ADR-025가 sub를 택한 주 근거(이메일 가변성)가 이 환경에선 성립하지 않는다.

## Decision (B′ — sub 전면 제거)
**근거 명시**: Cognito `sub`(UUID v4)는 **가독성이 전혀 없어**(대시보드·로그·롤명 모두 불투명) 식별자로 부적합하다. 이메일이 조직상 고유·불변이므로, **가독성 있는 식별자 = email(키)·subdomain(리소스명, =정규화된 email id)** 으로 단일화한다.
**subdomain 유니크 불변식 명시**: subdomain은 **플랫폼 전역에서 유니크 — 중복 이름을 허용하지 않는다.** 두 사용자가 같은 subdomain(→같은 롤·같은 한도 PK)을 절대 공유하지 않는다. email local-part 충돌(`john.doe@a`·`john_doe@b`→`john-doe`) 시 provisioner가 **disambiguation(suffix 부여: `john-doe`, `john-doe-2`, …)으로 유니크를 보장**하고, 부여된 subdomain은 Cognito `custom:subdomain`에 저장돼 이후 결정적으로 재사용된다(이미 배정된 기존 사용자는 그대로).

플랫폼 식별자를 **두 축으로 단일화**하고 Cognito sub를 식별자에서 **완전히 제거**한다:
- **usage·limits의 canonical 키 = email** (`USER#{email}`, 소문자 정규화). 비즈니스/감사/한도 키.
- **모든 IAM 롤 네이밍 = subdomain** (`cc-on-bedrock-task-{subdomain}`, `cc-on-bedrock-local-user-{subdomain}`). subdomain은 **email local-part의 DNS/IAM-safe 정규화형**(`derive_subdomain`: 소문자, `[a-z0-9-]`, 3–30자)이라 곧 "email id"이며, 이미 EC2 task 롤·DNS(`{subdomain}.{domain}`)·nginx `X-Auth-User`·routing-table이 쓰는 단일 이름이다. Local 롤만 sub였던 **내부 불일치를 해소**한다.
- **sub는 키도 행 속성도 아니다** — usage 행은 `email`·`subdomain`·`department`만 보존. enforcer/budget-check/limit-reset는 행의 `subdomain`에서 **두 롤명을 모두** 구성(`task-{subdomain}`, `local-user-{subdomain}`); subdomain 없으면 fail-safe skip(오롤 Deny 금지).
- 이메일·subdomain은 writer가 **인프라 태그에서 직접 획득**(EC2 인스턴스 태그 `username`/`cc:user`=email + `subdomain` 태그, Local 롤 `email`·`subdomain` 태그) — 쓰기 시점 Cognito 조회 불필요. 깨진 custom-filter 해석 제거.
- **전체 email을 롤명에 쓰지 않는다**: 64자 한도(prefix 25자 + 39자 초과 email은 깨짐)·롤↔DNS 이름 불일치 재발·`@`/`.` 파싱 위험 때문. 정규화 local-part(=subdomain, ≤30자)만 사용.
- **subdomain 충돌가드**(이미 EC2 task 롤에 존재: 같은 이름 롤이 다른 소유자로 태깅돼 있으면 raise)를 **Local 롤 provisioning에도 적용** — `john.doe@a`·`john_doe@b`가 둘 다 `john-doe`로 정규화될 때 **공유 대신 거부**(fail-safe). 충돌 사용자는 수동 subdomain 배정.
- **충돌가드의 소유권(ownership) 식별자 = email 로 통일** — 세 롤 생성기(`role_factory.ensure_role`, `ec2-clients.ts:ensureUserInstanceProfile`, `user-role-provisioner._ensure_ec2_task_role`) 모두 **`email`/`username` 태그**로 소유권을 판정한다. EC2 provisioner 가 남겨두던 **`cognito_sub` 태그·sub 기반 가드는 제거**(어디서도 읽지 않던 잔재) — sub 완전 제거 원칙과 정합.

### 마이그레이션 (재생성 승인됨)
- 기존 `USER#{sub}`·`USER#{subdomain}` 행 → 1회 backfill로 `USER#{email}` 병합(토큰 합계 보존 검증, dry-run 기본).
- 배포된 `cc-on-bedrock-local-user-{sub}` 롤 → **삭제 후 `cc-on-bedrock-local-user-{subdomain}`로 재생성**(trust·inline 정책 복제). IAM은 rename 불가하므로 신규 생성+구롤 삭제. sts-issuer AssumeRole 타깃을 subdomain으로 전환.

## Consequences
### Positive
- 동일인 **단일 키(email)** → 대시보드 정확·가독 + 한도 집행 정합(undercount/우회 해소).
- 식별자 **2축으로 단일화**(email=비즈니스, subdomain=리소스명), UUID 어디에도 없음 → 롤↔DNS 이름 일관, email→sub bridge·dual-mapping 제거로 코드 단순화.
- 쓰기 시점 Cognito 조회 제거(태그 기반) → 깨진 해석·fallback 소멸.
### Negative
- ADR-025 supersede — 트래커·enforcer·budget-check·limits·리더·provisioner(롤명)·backfill 다중 변경(보안 민감: 한도 집행 키).
- **IAM 롤 재생성 blast radius**: 배포된 Local 롤 삭제+재생성(정책·trust 복제), sts-issuer 타깃 전환. 진행 중 deny 연속성·AssumeRole 가용성 주의(dual-read + 배포 직후 backfill로 공백 0).
- subdomain local-part **충돌은 provisioning에서 fail-safe 거부**(EC2엔 기존 제약, 이제 Local로 확장) — 충돌 사용자 수동 배정 필요.
- 이메일 변경 시 재분할(조직상 불변 전제; 변경 시 수동 reconcile).

## References
- spec: `docs/superpowers/specs/2026-06-12-usage-email-canonical-key-design.md`
- supersedes ADR-025; 관련 ADR-014(Local Governance), ADR-015(deny names)
- 진단: 세션 2026-06-12 (mixed-key split + enforcer undercount)
