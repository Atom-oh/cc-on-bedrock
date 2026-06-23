---
status: Accepted
verification_required: false
date: 2026-06-23
consolidates: []
---

# 009: OTel 코드활동 관측 (EC2 → Collector 60s push · 생산성 모니터링)

## Status

Accepted (2026-06-23)

선행 번호 ADR 없음. 이 결정은 그동안 설계 스펙(`docs/superpowers/specs/2026-06-14-bedrock-productivity-monitoring-design.md`)에만 존재하던 OTel/생산성 모니터링 결정을 공식 ADR로 승격(formalize)한 것이다.
No prior numbered ADR — this formalizes the OTel/productivity-monitoring decision that previously lived only in a design spec.

## Context

Amazon Bedrock에는 Anthropic 1P의 Analytics/Admin/Compliance API가 없다. 따라서 비용·거버넌스(005 사용량 집계, 008 예산)는 풍부하지만 **생산성·참여(productivity/engagement) 지표는 관측 불가**였다. 핵심 통찰: 생산성 지표(LOC, commits, PRs, sessions, tool-acceptance 등)는 Anthropic API가 아니라 **Claude Code 클라이언트의 OpenTelemetry**가 백엔드(Bedrock/Vertex/1P)와 무관하게 동일하게 방출한다. Phase 0 스파이크에서 실제 Bedrock 세션으로 검증 완료(GO).

Amazon Bedrock exposes none of Anthropic's first-party Analytics/Admin/Compliance APIs, so the platform was cost- and governance-rich but productivity- and engagement-blind. The metrics are emitted by Claude Code's client-side OpenTelemetry regardless of backend, which makes them available to us. A Phase 0 spike confirmed they fire on real Bedrock.

아키텍처 상세는 `../architecture.md`(SSOT, pillar 3 코드활동 OTEL · pillar 4 사용량 metering)가 정본이며 여기서 재유도하지 않는다.

## Decision

**EC2 DevEnv는 코드활동 메트릭을 60초마다 OTEL Collector로 push한다. Collector → 집계(rollup) → DynamoDB 파이프라인으로 생산성/참여 지표를 산출하며, 키는 005/ADR-031과 동일한 email canonical key로 통일한다.**

**EC2 DevEnv pushes code-activity metrics to an OTEL Collector every 60s; the Collector → aggregation → DynamoDB pipeline produces productivity/engagement metrics, keyed by the same email canonical key as 005 (ADR-031).**

- **Emit (EC2 60s push).** EC2 DevEnv는 60초 systemd timer로 코드활동 메트릭(repo count, total/last-minute commits, tracked LoC, review markers)을 OTLP HTTP로 Collector에 보낸다 (`tools/cc-otel-code-metrics.sh`). 추가로 Claude Code 클라이언트 OTel(`CLAUDE_CODE_ENABLE_TELEMETRY=1`, sessions/LOC/acceptance 등)도 같은 Collector로 흐른다.
- **Pipeline = Option A (Collector → DynamoDB).** Managed Prometheus/Grafana(B)나 CloudWatch metrics/EMF(C)가 아닌, Collector → durable buffer → rollup → DynamoDB를 택한다. 멀티모델 패널(Claude+Codex+Gemini)이 A에 합의.
- **Identity = email canonical key (005/ADR-031).** rollup은 **일 단위 집계 + presence 레코드만** 기록(원시 datapoint 비영속). PK `USER#{email}`. department는 기존 추적기(EC2 tag/Cognito attribute) 로직 재사용. EC2/ECS에서는 Collector가 신뢰 가능한 source로 `enduser.id`를 **덮어쓴다**; Local Governance(ADR-014/006)는 자기보고 신뢰경계로 문서화하고 rollup이 Bedrock invocation log와 cross-check해 불일치를 flag한다.
- **Privacy.** 프롬프트/텍스트/이미지 내용은 절대 로깅하지 않는다 — 메트릭은 counter만 운반. 고비용 CloudWatch Logs 싱크 회피.
- **Authoritative cost stays 005.** 비용 attribution(per-skill/agent/model)은 OTel 기반 **근사치(Attributed)**이며, 권위 있는 청구 수치는 005의 Bedrock invocation-log 파이프라인(Billed)이 계속 보유한다.

구체적 buffer(Firehose vs SQS), Collector 사이징, OTLP temporality(`delta` sum 고정 필요), ap-northeast-2 정확 단가는 Phase 1에서 확정하는 미해결 항목으로 남긴다.

## Consequences

긍정 / Positive
- Anthropic API 없이 Bedrock 위에서 생산성/참여(DAU/WAU/MAU, LOC, commits/PRs, acceptance) 가시성 확보. 기존 Next.js 대시보드·DynamoDB·email 키 재사용.
- 원시 datapoint 비영속(일 rollup만) → WCU/스토리지 폭증 회피.

부정·위험 / Negative & risk
- Local PC `OTEL_RESOURCE_ATTRIBUTES`는 사용자 설정 가능 → identity tampering. 완화: EC2/ECS Collector 덮어쓰기 + Bedrock log cross-check + 불일치 flag. 제거가 아닌 **문서화된 신뢰경계**.
- Collector ECS 서비스가 SPOF가 될 수 있어 durable buffer를 rollup 앞에 둔다(스파이크/Lambda 실패가 데이터 손실로 이어지지 않게).
- OTLP delta temporality 미고정 시 last-value 오집계 위험 — Phase 1에서 검증.

보안 / Security
- 내용(prompt/text/image) 무로깅, counter-only. OTLP는 TLS·인증 엔드포인트.
- 0.0.0.0/0 · Principal:"*" · 평문 시크릿 도입 없음. email 키 처리는 005/ADR-031 불변식 준수.

## Consolidates

선행 번호 ADR 없음 (no prior numbered ADR). 이 ADR은 설계 스펙 `docs/superpowers/specs/2026-06-14-bedrock-productivity-monitoring-design.md`(Productivity & Engagement Monitoring, Option A)를 공식화한다.

This ADR formalizes the design spec `docs/superpowers/specs/2026-06-14-bedrock-productivity-monitoring-design.md`. There is no legacy ADR body to retire; consolidated-ADR git tag `adr-legacy-2026-06-23` and `../history/ADR-MAPPING.md` record the spec→ADR mapping. 번호 재사용 금지.

Cross-ref: **005** (사용량 집계 · email canonical key — 권위 있는 비용/청구 정본), 006 (공유 자격증명·Local Mode), 008 (예산 집행).
