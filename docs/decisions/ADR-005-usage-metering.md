---
status: Accepted
verification_required: false
date: 2026-06-23
consolidates: [ADR-011, ADR-019, ADR-031, ADR-025]
---

# 005: 사용량 집계 (Inference Profile + Invocation Log → DynamoDB · email canonical key)

> 통합 ADR. 흡수: ADR-011(IAM cost allocation) · ADR-019(model-ID normalization) · ADR-031(email canonical key) · ~~ADR-025~~(superseded). 옛 본문 → git tag `adr-legacy-2026-06-23`, 매핑 `../history/ADR-MAPPING.md`.

## Status / 상태
Accepted (2026-06-23). Supersedes archived ADR-025 (Cognito-sub canonical key).

## Context / 배경

KR — 멀티유저 플랫폼은 사용자별 Bedrock 사용량을 초 단위로 집계해 대시보드 표시·예산 집행(ADR-008)의 단일 입력으로 삼아야 한다. 세 가지 결정이 한 파이프라인에 얽혀 있어 통합한다:
- **집계 소스**: account-wide CloudWatch `AWS/Bedrock` 메트릭은 사용자 귀속이 불가능하고, LiteLLM 같은 프록시는 자격증명 경로에 단일 장애점·토큰 가로채기를 끼운다.
- **모델 표기 난립**: 동일 모델이 inference-profile ARN, foundation-model ARN, profile ID + `[1m]` suffix, date-suffix 등 여러 표기로 호출돼 키·가격이 분열한다.
- **사용자 키**: 트래커는 `subdomain`, 리더는 Cognito `sub`로 키가 갈려 동일인 이중집계 + 한도 집행 우회가 발생했다(2026-06-12 진단, ADR-031).

EN — Per-user Bedrock usage must be metered near-real-time as the single input to the dashboard and budget enforcement (ADR-008). Three previously separate decisions live in one pipeline and are consolidated here.

## Decision / 결정

### 1. 집계 소스 = Application Inference Profile + Invocation Log → DynamoDB
- 모든 호출(EC2·Local 양 경로, ADR-006)은 **동일 Application Inference Profile**에 귀속된다. Bedrock **Invocation Logging**(+CloudTrail 보조)이 호출당 input/output 토큰·model ID를 내보내고, `bedrock-usage-tracker` Lambda가 정규화·집계 후 DynamoDB(`cc-on-bedrock-usage`)에 기록한다.
- **NOT LiteLLM** — 프록시를 자격증명 경로에 두지 않는다(SPOF·토큰 가로채기 회피).
- **NOT CloudWatch account-wide** — `AWS/Bedrock` 계정 메트릭은 per-user 귀속 불가라 채택하지 않는다.

### 2. Canonical key = email (ADR-031; supersedes ADR-025 Cognito-sub)
- usage·limits의 **canonical 키 = email** (`USER#{email}`, 소문자 정규화). 비즈니스/감사/한도 키.
- **모든 IAM 롤 네이밍 = subdomain** (`cc-on-bedrock-task-{subdomain}`, `cc-on-bedrock-local-user-{subdomain}`). subdomain은 email local-part의 DNS/IAM-safe 정규화형(소문자, `[a-z0-9-]`, 3–30자)인 **파생 리소스명이지 제2의 신원이 아니다**. subdomain은 플랫폼 전역 유니크 — **신규 subdomain 할당 시** local-part가 겹치면 provisioner가 suffix(`-2`)로 disambiguate하고 Cognito `custom:subdomain`에 저장해 결정적 재사용한다(*신규 할당* 시나리오 — 아래 §의 "기존 role 소유권 충돌" 거부와 다른 경로).
- **Cognito sub는 키도 행 속성도 아니다** — 식별자에서 완전 제거. 가독성 0(UUID)이라 부적합. email/subdomain은 writer가 인프라 태그(EC2 인스턴스 `username`/`cc:user`=email + `subdomain`; Local 롤 `email`·`subdomain` 태그)에서 직접 획득 — 쓰기 시점 Cognito 조회 불필요(깨진 `custom:subdomain` 필터 해석 제거).
- enforcer/budget-check는 행의 `subdomain`에서 두 롤명을 모두 구성; subdomain 부재 시 fail-safe skip(오롤 Deny 금지). 충돌가드 소유권 식별자 = email로 통일.

### 3. Model-ID normalization (ADR-019)
- `normalize_model(model_id)`가 모든 호출 경로의 model ID를 단일 short form으로 환원(예: `arn:...inference-profile/global.anthropic.claude-sonnet-4-6-v1` → `claude-sonnet-4-6`). 적용 순서: `/` 마지막 segment → `arn:` colon-split → vendor prefix(`global.anthropic.` 등) 제거 → colon suffix → `[1m]` → version(`-vN`) → 8자리 date suffix(`-\d{8}$`) 제거.
- 정규화된 short form이 DynamoDB SK(`{date}#{model}`)·`PRICING` dict·ADR-008 normalized-token family 판정의 **단일 진실 원천**. partial-match로 새 date-suffix SKU 자동 분류, raw modelId는 로그에만 보존(lossy).

### 4. Cost allocation hybrid (ADR-011)
- 커스텀 시스템(Lambda+DynamoDB, ~초 지연)이 5분 예산 집행(ADR-008)의 입력으로 **정본**. AWS 네이티브 cost allocation(CUR 2.0 / Cost Explorer, ~24h)은 재무 정산용 **보조 채널**.
- per-user 롤에 `username`/`email`·`department`·`project` 태그를 컨테이너 시작 시 upsert해 비용 귀속 가능(별도 migration 스크립트 불필요). Application Inference Profile ARN이 롤 inline policy Resource에 포함돼 dept 단위 attribution 지원.
- CUR 2.0 export(`INCLUDE_CALLER_IDENTITY`)는 BCM Data Exports API 미지원으로 **보류**.

## Consequences / 결과

### Positive
- 동일인 단일 키(email) → 대시보드 정확·가독 + 한도 집행 정합(undercount/우회 해소).
- 식별자 2축 단일화(email=비즈니스, subdomain=리소스명·DNS·롤명 일관), UUID 제거로 bridge/dual-mapping 코드 삭제.
- 모델 1일 1 row per family → DynamoDB 폭증·가격 미스 방지, 새 SKU 자동 분류.
- 자격증명 경로에 프록시 없음 → SPOF·토큰 가로채기 위험 0.

### Negative
- ADR-025 supersede 시 트래커·enforcer·budget-check·limits·리더·provisioner(롤명)·backfill 다중 변경(보안 민감). 배포된 Local 롤 삭제+재생성(IAM rename 불가), sts-issuer AssumeRole 타깃 전환 — dual-read + 배포 직후 backfill로 공백 0.
- **기존 role이 다른 email 소유로 존재하는 충돌(role 소유권 충돌)**은 provisioning에서 fail-safe 거부(RuntimeError) → 수동 배정. (신규 할당의 auto-suffix `-2`와 **다른 시나리오** — §위 참조.)
- 이메일 변경 시 재분할(조직상 재직 중 불변 전제; 변경 시 수동 reconcile).
- 정규화는 silent·lossy — 새 family(`claude-opus-5`)나 vendor prefix 출시 시 rule 수동 갱신.
- CUR 2.0 보조 채널 ~24h 지연 — 실시간 대시보드 부적합(커스텀 시스템이 그 역할).

## Consolidates / 통합 출처

| LEGACY | 토픽 | 본 ADR 반영 |
|---|---|---|
| ADR-011 | Bedrock IAM cost allocation hybrid | §4 (커스텀 정본 + CUR 2.0 보조, 롤 태그) |
| ADR-019 | model-ID normalization | §3 (`normalize_model` 단일 진실 원천) |
| ADR-031 | usage/limits canonical key = email | §2 (email 키, subdomain 롤명, sub 제거) |
| ~~ADR-025~~ | canonical key = Cognito sub | **superseded** by ADR-031 (§2); archived |

옛 본문은 트리에 없다 — git tag `adr-legacy-2026-06-23`로 보존, 매핑은 `../history/ADR-MAPPING.md`. SSOT = `../architecture.md` pillar 4·5. Index = `BASELINE.md` §3 row 005.

## References
- `../architecture.md` (SSOT pillars 4 Usage metering, 5 Shared credential model)
- ADR-006 공유 자격증명 · ADR-008 예산 집행(정규화 토큰·EventBridge→IAM deny)
- spec: `docs/superpowers/specs/2026-06-12-usage-email-canonical-key-design.md`
- `lambda/bedrock-usage-tracker.py` (`normalize_model`, email-keyed write)
