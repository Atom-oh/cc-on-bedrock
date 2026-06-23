---
status: Superseded
superseded_by: ADR-031
date: 2026-06-09
verification_required: false
builds_on: ADR-014
---

> **[ARCHIVED — SUPERSEDED, NOT CURRENT ARCHITECTURE]** Replaced by ADR-031. Do NOT use for current design. Current truth = `docs/decisions/BASELINE.md` + `docs/architecture.md`. Kept for history only.


# ADR-025: 사용량/한도 파이프라인의 canonical 유저 식별자 = Cognito sub

> **⚠ Superseded by [ADR-031](ADR-031-usage-email-canonical-key.md) (2026-06-13).** 운영 진단: sub 키는 (a) 트래커 EC2 경로의 `custom:subdomain` 필터가 Cognito 미지원 → 항상 실패 → `USER#{subdomain}` fallback으로 **동일인 분할 + 집행 우회**, (b) UUID라 가독성 0. ADR-031는 canonical 키를 **email**, 모든 IAM 롤명을 **subdomain**으로 전환하고 sub를 식별자에서 제거한다.

**Status:** Superseded by ADR-031 — (구) 코드 cutover 구현 완료(usage-tracker/budget-check/enforcer sub-키), stale 비-Cognito 레코드 정리 완료(2026-06-10, `scripts/cleanup-stale-budget-users.py`)
**Date:** 2026-06-09
**Builds on:** [ADR-014 Local Governance Mode](ADR-014-local-governance-mode.md)
**Collaboration:** co-agent 패널(Kiro CLI · Codex · Gemini) 의사결정, Claude chair 합성

## Context

사용량 측정·한도 제어 파이프라인이 **유저를 식별하는 키를 컴포넌트마다 다르게** 사용하고 있어,
두 유저 경로(EC2 DevEnv / Local Governance)의 "동일 측정·동일 제어"가 부분적으로만 성립한다.

검증된 비일관성:
- **쓰기 측은 subdomain 기반** — `bedrock-usage-tracker.resolve_user_from_arn` 은 usage 행을
  `USER#{subdomain}` 로 기록(Local 은 역할 `username` 태그로 resolve, 실패 시 `cognito_sub` 폴백).
  `token-limit-enforcer._attach_deny` 도 카운터·`DENY#active` 를 `USER#{subdomain}` 에 기록.
- **읽기 측은 Cognito sub(UUID) 기반** — `local/limits/route.ts` 는 `USER#{session.user.id}`(=sub),
  `sts-issuer._get_limit_status(sub)` 도 `USER#{sub}` 로 조회.
- `subdomain ≠ sub` 이므로 유저의 `/local` 사용량 게이지·한도 상태가 실제 기록과 어긋난다
  (IAM Deny 하드 차단은 `username` 태그 역해석으로 동작하지만, 표시·집계가 빗나감).

근본 제약:
- **subdomain 은 가변** — admin reset 플로우가 `custom:subdomain` 을 clear/재할당 → PK 가 흔들리면
  기존 usage 이력이 고아 행이 된다.
- **subdomain 은 일부 유저에 부재** — Local Governance(`governanceOnly`) 배포에선 EC2 가 없어
  subdomain 미할당 유저가 존재할 수 있다.
- **Cognito sub 는 모든 유저가 항상 보유하고 불변**이며, Local 역할명
  `cc-on-bedrock-local-user-{cognito_sub}` 과 읽기 라우트가 **이미 sub 기반**이다.

(모델 차원 — Opus 4.8 등 신모델 — 은 정규화·가격(ADR 별 family-fallback 수정)·normalized weight 가
모두 version-agnostic 이라 두 경로 공통으로 정상. 본 ADR 의 대상이 아니다.)

## Decision

usage(`cc-on-bedrock-usage`) 및 limits(`cc-on-bedrock-limits`) 파이프라인의 **canonical 유저
식별자를 Cognito sub(UUID)로 통일**한다. 쓰기 측(tracker, enforcer, admin/limits 저장)을 이미
sub 기반인 읽기 측에 맞춘다. 사람 가독성은 **표시 계층에서 sub→subdomain 매핑**
(Cognito `custom:subdomain` lookup 또는 매핑 GSI)으로 보완한다.

영향 받는 컴포넌트:
- `bedrock-usage-tracker.resolve_user_from_arn` — 두 경로 모두 `USER#{sub}` 기록.
  EC2 task 경로는 역할에 sub 태그 부여 또는 subdomain↔sub 매핑으로 sub 확보.
- `token-limit-enforcer` — 카운터·`DENY#active` 를 `USER#{sub}` 에 기록.
- `admin/limits` — 한도 저장 키를 sub 로(UI 표시는 subdomain, 저장은 sub).
- `local/limits`, `sts-issuer._get_limit_status` — 이미 sub 기반, 변경 없음.

## Considered Alternatives

### A. Cognito sub(UUID)로 전 구간 통일 — **채택**
- **장점:** 불변(가변 PK로 인한 고아 행 없음 — *Kiro*), 모든 유저 보유(Local-only 강제발급 불필요
  — *Gemini*), Local 역할명·읽기 라우트가 이미 sub 기반이라 정렬 운영부담이 작음(*Codex*).
- **단점:** 저장 키가 사람이 못 읽음 → 표시 계층 매핑 필요.

### B. subdomain 으로 전 구간 통일 + 모든 유저에 subdomain 강제 발급 — 기각
- subdomain 의 **가변성**(admin reset)이 PK 안정성을 해치고, Local-only 유저에 **강제 발급 +
  유효성 충돌 처리** 로직을 새로 얹어야 한다(*Kiro/Gemini* 공통 지적). 가독성 이점만으로는
  불변·보편 식별자를 포기할 이유가 못 됨.

### C. 현상 유지(혼용) — 기각
- 측정/표시가 계속 어긋나고, 두 경로의 "동일 측정·제어" 요구를 충족하지 못한다.

### D. 복합 키(sub#subdomain) 또는 email — 기각
- 복합 키는 조회·집계 복잡도만 키우고, email 은 가변(@/. 로 기존 username 정규식과 충돌)이라
  현재 폴백 버그의 원인 중 하나다.

## Consequences

**긍정:**
- 두 유저 경로(EC2·Local)가 단일 키로 통일 → 측정·한도·DENY 상태가 일관.
- subdomain 재할당/미할당에 영향받지 않는 안정적 usage 이력.
- 읽기 측 무변경 — 변경 표면이 쓰기 측 + 마이그레이션으로 한정.

**부정/비용:**
- 저장 키 가독성 상실 → **표시 계층에 sub→subdomain 매핑 필수**(*Kiro*). 대시보드/CloudWatch/로그.
- EC2 task 경로에 sub 확보 수단(역할 sub 태그 또는 매핑) 추가 필요.

**리스크 & 마이그레이션 (안전 cutover — *Kiro* 제안):**
1. tracker 를 **dual-write**(`USER#{subdomain}` + `USER#{sub}`) 로 먼저 배포.
2. 기존 `USER#{subdomain}` → `USER#{sub}` **backfill** — Cognito 에서 subdomain↔sub **1:1 검증**
   후 일괄 변환(*Gemini/Codex* 매핑 정확도 검증 강조), 전환기 중복/누락 방지.
3. 읽기·집계를 sub 로 cutover → subdomain 키 폐기.
4. 표시 계층 sub→subdomain 매핑 추가.

**검증 필요(verification_required):** 마이그레이션 후 동일 유저의 EC2·Local 사용량이 단일
`USER#{sub}` 로 합산되는지, `/local` 게이지·한도 상태가 enforcer 기록과 일치하는지 E2E 확인.

## Verification

**Superseded — no active verification.** This ADR's canonical key (`USER#{sub}`, Cognito sub) was
replaced by **[ADR-031](ADR-031-usage-email-canonical-key.md)** (`USER#{email}`). The static/semantic
assertions that once pinned the `USER#{sub}` implementation no longer match the codebase by design,
so they are removed here (a superseded ADR must not assert its replaced behavior). The current
usage-pipeline key is verified by ADR-031.

## Follow-ups (RESOLVED — cutover 완료)
- ~~dual-write tracker 구현(1단계) → backfill 스크립트 → cutover.~~ **RESOLVED**: tracker가 직접 `USER#{sub}` 단일 키로 기록하도록 cutover 완료. dual-write/backfill 단계는 불필요해져 생략됨.
- ~~EC2 task 역할 sub 태그 부여 방안 결정(provisioner/UserData).~~ **RESOLVED**: 역할 sub 태그 방식은 채택하지 않음. 대신 `bedrock-usage-tracker._resolve_sub_from_subdomain()`이 EC2 subdomain→sub를 **Cognito ListUsers lookup**(`custom:subdomain` 필터)으로 역해석한다. 역할에 sub 태그를 추가하지 않는다.
- ~~표시 계층 sub→subdomain 매핑(Cognito lookup vs GSI) 선택.~~ **RESOLVED**: Cognito lookup 방식 채택 (위와 동일 메커니즘, GSI 미사용).
