---
status: Accepted
verification_required: false
date: 2026-06-23
consolidates: [ADR-014, ADR-029]
---

# 006: 공유 자격증명 (EC2·Local 동일 inference profile · STS issuer · credential_process 1h 갱신)

> Consolidated ADR. 단일 현행 진실은 `../architecture.md`(SSOT)와 `BASELINE.md` §3 row 006.
> 옛 본문은 git tag `adr-legacy-2026-06-23` 및 `../history/ADR-MAPPING.md`로 보존.

## Status / 상태
Accepted (2026-06-23). Consolidates ADR-014, ADR-029.

## Context / 배경

CC-on-Bedrock은 두 접근 경로를 갖는다 — per-user **EC2 DevEnv**(ADR-004 / SSOT §6)와
**Local Mode**(`governanceOnly`, BASELINE §2 GATED). 두 경로 모두 회사 자격으로 Bedrock을
호출하되 사용량·예산·IAM 권한이 중앙에서 거버넌스되어야 한다. 핵심 질문: **두 경로의 자격증명을
어떻게 통일해 한 축으로 귀속·통제하는가.**

Both access paths must call Bedrock under corporate credentials while usage, budget, and IAM
permissions stay centrally governed. The question is how to unify their credentials so usage can
be attributed and controlled on a single axis.

Local Mode 자격증명 발급에는 두 후보가 있었다 — **(1) IAM + Application Inference Profile**(STS
단기 자격으로 Claude Code가 Bedrock 직접 호출) vs **(2) LLM Gateway**(게이트웨이가 인증·쿼터·DLP
재서명). 게이트웨이는 "EC2 제거" 목표와 충돌(SPOF·패치·신기능 대기)하고, IAM principal 기반 비용
할당·예산 강제는 이미 검증된 메커니즘이라 호출 위치와 무관하게 재사용 가능하다.

## Decision / 결정

### 1. 공유 자격증명 모델 — 같은 inference profile, 같은 정책 shape (literal role은 공유 금지)
EC2와 Local Mode는 **동일 Application Inference Profile**로 사용량을 귀속한다. 두 경로는
**하나의 literal IAM role을 공유하지 않는다** — 공유하는 것은 **정책 shape·permission boundary·태그·
inference-profile 귀속**뿐이다 (SSOT §5, hard rule "Do not use one literal IAM role for both EC2
and Local mode"). Bedrock Invocation Log이 호출 위치와 무관하게 IAM principal로 기록되므로, 동일
inference profile + 동일 태그 정책이면 EC2·Local 사용량이 한 파이프라인(005)으로 합쳐진다.

EC2 and Local Mode attribute usage through the **same Application Inference Profile** but never
through one literal IAM role; they share policy shape, permission boundary, tags, and
inference-profile attribution only.

### 2. Local Mode 자격증명 흐름 — Cognito public client → Dashboard → STS issuer
```
cc-bedrock-local CLI
  → Cognito public client (로그인 / refresh)
  → Dashboard /api/local/credentials
  → STS issuer (assumed-role가 per-user role을 AssumeRole, role-chaining)
  → STS 단기 자격증명 (TTL 1h)
  → Bedrock InvokeModel (Application Inference Profile)
```
per-user role(`cc-on-bedrock-local-user-{subdomain}`, ADR-031로 네이밍 정정)은 boundary X로
캡되고(007), trust policy는 STS issuer만 AssumeRole 허용, 태그(`username`/`department`/`project`/
`mode=local`)로 귀속한다. **(1) IAM + Application Inference Profile** 방식을 채택, 게이트웨이는
실시간(<1초) 쿼터/고급 DLP가 비즈니스 요구로 등장할 때 별도 ADR(Phase 2)로 보류.

### 3. STS 1h 한도 → `credential_process` 자동 갱신
STS issuer는 assumed-role가 user role을 다시 AssumeRole하는 **role-chaining**이라 AWS가 세션을
**1시간 hard cap**으로 강제한다(`MaxSessionDuration`과 무관, 8h 요청은 ValidationError; 실측 60.0분).
짧은 토큰은 거버넌스상 **장점**(한도 초과 Deny가 최대 1h 내 모든 활성 세션에 반영)이므로 유지하고,
세션 연속성은 AWS SDK **`credential_process` 훅**으로 해결한다:

```ini
# ~/.aws/config
[profile cc-bedrock]
credential_process = /path/to/cc-bedrock-local.sh credential-process
region = ap-northeast-2
```
SDK는 `Expiration` 임박 시 훅을 자동 재호출 — 캐시 TTL>5분이면 즉시 응답, 아니면 Cognito refresh
token으로 무인 STS 재발급. 훅은 **절대 프롬프트하지 않으며**(헤드리스), stdout엔 `{"Version":1,...}`
JSON만 출력한다. `~/.aws/credentials`의 레거시 정적 키 섹션은 제거한다(credentials가
credential_process보다 우선하므로). 수명 체인:

```
STS 1h          ──(SDK가 Expiration 전 훅 재호출)──▶ 무한 연장
Cognito access  ──(refresh token으로 silent 재발급)──▶ 무한 연장
Cognito refresh 30d ──(만료 시)──▶ 'cc-bedrock-local login' 1회
```

## Consequences / 결과

**Positive**
- EC2·Local 사용량이 동일 inference profile로 단일 파이프라인(005)에 귀속 — 부서별 cost attribution 일관.
- literal role 분리로 두 경로의 권한·신뢰 경계를 독립 관리(boundary X, 007).
- 1h 토큰 유지 → 한도 초과 Deny가 ≤1h 내 모든 세션 반영(008 예산 집행과 정합).
- credential_process로 수십 시간 연속 세션 무중단(재로그인 30일 1회). 정적 키가 디스크에서 사라짐(보안 소폭 개선).

**Negative / Trade-offs**
- 차단 latency 1–3분(Bedrock Invocation Log 지연 하한) — 한도 ~5% 안전 마진 운영.
- Cognito refresh token(30d) 세션 중 만료 시 1회 재로그인 필요(월 1회 미만).
- credential_process 미지원 도구(순수 env 주입)는 정적 snippet 경로 → 1h 제한 유지.
- per-user IAM role 인플레이션 — 계정 role 한도 근접 시 페이즈드 cleanup.

**Out of scope**
- 실시간(<1초) 쿼터·고급 DLP — LLM Gateway Phase 2 별도 ADR.
- 프롬프트 텍스트 감사 저장 — `textDataDeliveryEnabled=false`로 의도적 미포함.

## Cross-references / 교차 참조
- **005 사용량 집계** — 동일 Application Inference Profile + Invocation Log → DynamoDB(email canonical key).
- **007 IAM 신청·boundary** — per-user role을 캡하는 boundary X(AllowInAccount + DenyEscalation), runtime upsert.
- **008 예산 집행** — normalized token / $ 한도 초과 시 EventBridge → IAM Deny(1h 토큰이 반영창 상한).
- SSOT `../architecture.md` §5(Shared credential model), §2(access paths), hard rules.

## Consolidates / 통합 출처
이 ADR은 다음 LEGACY ADR을 통합한다. 옛 본문은 트리에 없고 git tag `adr-legacy-2026-06-23` 및
`../history/ADR-MAPPING.md`로 보존된다.

| Legacy | 제목 | 본 ADR 반영 |
|---|---|---|
| ADR-014 | Local Governance Mode (IAM + Inference Profile, STS issuer) | §1 공유 모델, §2 흐름·채택 근거 |
| ADR-029 | Local Mode credential_process 세션 자동 갱신 (1h role-chaining cap) | §3 credential_process 갱신 |

> 네이밍/키 정정: ADR-031이 per-user role을 `...-local-user-{cognito_sub}` → `{subdomain}`,
> 사용량·한도 PK를 `USER#{sub}` → `USER#{email}`로 변경. 본 ADR은 정정본을 반영한다.
