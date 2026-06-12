---
status: Accepted
verification_required: true
---

# ADR-029: usage/limits canonical key = email (supersedes ADR-025 sub)

## Status
Accepted — **supersedes [ADR-025](ADR-025-usage-pipeline-canonical-identifier.md)** (canonical = Cognito sub).

## Context
ADR-025는 canonical 사용자 키를 Cognito sub(UUID)로 정했다. 운영 중 진단(2026-06-12) 결과:
- usage 트래커 EC2 경로의 `_resolve_sub_from_subdomain`이 `Filter='custom:subdomain=...'`를 쓰는데 **Cognito ListUsers는 custom 속성 필터 미지원** → 항상 실패 → `USER#{subdomain}` fallback. Local 경로만 `USER#{sub}`.
- 결과: 동일인이 `USER#{subdomain}` + `USER#{sub}` 두 행으로 분할(대시보드 이중집계), 그리고 `token-limit-enforcer`가 PK=sub를 가정해 `USER#{subdomain}` 사용량을 **존재하지 않는 한도에 조회 → 집행 누락(우회)**.
- UUID는 대시보드 가독성도 나쁘다.

조직 정책상 **이메일은 사용자별 고유·재직 중 불변**(퇴사까지) — ADR-025가 sub를 택한 주 근거(이메일 가변성)가 이 환경에선 성립하지 않는다.

## Decision
**usage·limits의 canonical 키 = email** (`USER#{email}`).
- sub·subdomain은 키가 아닌 **usage 행 속성**으로 보존(enforcer가 Local 롤명 구성에 sub 사용).
- **IAM 롤 네이밍은 불변**(`cc-on-bedrock-task-{subdomain}`, `cc-on-bedrock-local-user-{sub}`) — IAM 제약·기존 자산 보호. usage/limits 키만 email.
- 이메일은 writer가 **인프라 태그에서 직접 획득**(EC2 인스턴스 태그 `username`/`cc:user`, Local 롤 `email` 태그) — 쓰기 시점 Cognito 조회 불필요. 깨진 custom-filter 해석 제거.
- enforcer는 한도를 `USER#{email}`로 조회, Local 롤명은 usage 행의 `sub` 속성에서 구성(없으면 fail-safe skip).
- 기존 `USER#{sub}`·`USER#{subdomain}` 행은 1회 backfill로 `USER#{email}`에 병합(토큰 합계 보존 검증).

## Consequences
### Positive
- 동일인 단일 키 → 대시보드 정확·가독(이메일) + 한도 집행 정합(undercount/우회 해소).
- 쓰기 시점 Cognito 조회 제거(태그 기반) → 깨진 해석·fallback 소멸.
### Negative
- ADR-025 supersede — 트래커·enforcer·limits·리더·backfill 다중 변경(보안 민감: 한도 집행 키).
- 이메일 변경 시 재분할(조직상 불변 전제; 변경 시 수동 reconcile).
- IAM 롤은 여전히 sub/subdomain 네이밍 → usage(email)↔롤(sub/subdomain) 간 행 속성 매핑 의존.

## References
- spec: `docs/superpowers/specs/2026-06-12-usage-email-canonical-key-design.md`
- supersedes ADR-025; 관련 ADR-014(Local Governance), ADR-015(deny names)
- 진단: 세션 2026-06-12 (mixed-key split + enforcer undercount)
