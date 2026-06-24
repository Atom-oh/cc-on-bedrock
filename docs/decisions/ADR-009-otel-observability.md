---
status: Accepted
verification_required: false
date: 2026-06-23
consolidates: []
---

# 009: OTel 코드활동 관측 (경량 session/git 이벤트 · 생산성 모니터링)

## Status

Accepted (2026-06-23)

선행 번호 ADR 없음. 이 결정은 그동안 설계 스펙(`docs/superpowers/specs/2026-06-14-bedrock-productivity-monitoring-design.md`)에만 존재하던 OTel/생산성 모니터링 결정을 공식 ADR로 승격(formalize)한 것이다.
No prior numbered ADR — this formalizes the OTel/productivity-monitoring decision that previously lived only in a design spec.

## Context

Amazon Bedrock에는 Anthropic 1P의 Analytics/Admin/Compliance API가 없다. 따라서 비용·거버넌스(005 사용량 집계, 008 예산)는 풍부하지만 **생산성·참여(productivity/engagement) 지표는 관측 불가**였다. 핵심 통찰: 생산성 지표(LOC, commits, PRs, sessions, tool-acceptance 등)는 Anthropic API가 아니라 **Claude Code 클라이언트의 OpenTelemetry**가 백엔드(Bedrock/Vertex/1P)와 무관하게 동일하게 방출한다. Phase 0 스파이크에서 실제 Bedrock 세션으로 검증 완료(GO).

Amazon Bedrock exposes none of Anthropic's first-party Analytics/Admin/Compliance APIs, so the platform was cost- and governance-rich but productivity- and engagement-blind. The metrics are emitted by Claude Code's client-side OpenTelemetry regardless of backend, which makes them available to us. A Phase 0 spike confirmed they fire on real Bedrock.

아키텍처 상세는 `../architecture.md`(SSOT, pillar 3 코드활동 OTEL · pillar 4 사용량 metering)가 정본이며 여기서 재유도하지 않는다.

## Decision

**EC2 DevEnv는 Claude session heartbeat와 git commit/push 같은 저비용 이벤트만 OTEL Collector로 보낸다. Bedrock token/cost는 005의 Invocation Log → DynamoDB 파이프라인을 계속 권위 source로 사용한다.**

**EC2 DevEnv emits only low-cost Claude session heartbeat and git commit/push events to the OTEL Collector. Bedrock token/cost stays authoritative in the 005 Invocation Log → DynamoDB pipeline.**

- **Emit (event-based).** `tools/cc-otel-code-metrics.sh`는 더 이상 전체 workspace를 매분 스캔하지 않는다. 얇은 `claude` wrapper가 session start/end를, 5분 systemd timer가 active heartbeat를, 얇은 `git` wrapper가 성공한 `commit`/`push`와 commit의 added/deleted line count만 OTLP HTTP로 보낸다.
- **Pipeline = low-cardinality metrics first.** 운영 비용을 낮추기 위해 기본 dimension은 department/mode 중심으로 제한한다. prompt, file path, branch, commit SHA, raw email, session id는 metric dimension으로 쓰지 않는다.
- **Identity.** 사용자 단위 분석은 기존 005 사용량 테이블(email canonical key)과 필요 시 별도 daily aggregate에서 처리한다. CloudWatch custom metric에는 raw user 식별자를 기본 포함하지 않는다.
- **Privacy.** 프롬프트/텍스트/이미지 내용은 절대 로깅하지 않는다 — 메트릭은 counter만 운반. 고비용 CloudWatch Logs 싱크 회피.
- **Authoritative cost stays 005.** 비용 attribution(per-skill/agent/model)은 OTel 기반 **근사치(Attributed)**이며, 권위 있는 청구 수치는 005의 Bedrock invocation-log 파이프라인(Billed)이 계속 보유한다.

구체적 daily rollup 저장소(DynamoDB vs Timestream)와 사용자별 aggregate 확장은 후속 단계로 남긴다. 현재 기본 구현은 session/heartbeat/git 이벤트를 작고 싼 메트릭으로 유지한다.

## Consequences

긍정 / Positive
- Anthropic API 없이 Bedrock 위에서 기본 참여 추세(session, active heartbeat, commit/push, lines changed) 가시성 확보.
- 전체 repo scan 제거 → EC2 CPU/IO와 CloudWatch metric/cardinality 비용을 낮게 유지.

부정·위험 / Negative & risk
- Local PC telemetry is optional because the default Collector endpoint is internal. If a public OTLP endpoint is configured later, local identity remains self-reported and must not become an authoritative billing/control signal.
- Git wrapper는 Claude/DevEnv PATH 안에서 관측되는 `git commit`/`git push`만 잡는다. GitHub webhook/PR/CI outcome 지표는 후속으로 붙인다.

보안 / Security
- 내용(prompt/text/image) 무로깅, counter-only. OTLP는 TLS·인증 엔드포인트.
- 0.0.0.0/0 · Principal:"*" · 평문 시크릿 도입 없음. email 키 처리는 005/ADR-031 불변식 준수.

## Consolidates

선행 번호 ADR 없음 (no prior numbered ADR). 이 ADR은 설계 스펙 `docs/superpowers/specs/2026-06-14-bedrock-productivity-monitoring-design.md`(Productivity & Engagement Monitoring, Option A)를 공식화한다.

This ADR formalizes the design spec `docs/superpowers/specs/2026-06-14-bedrock-productivity-monitoring-design.md`. There is no legacy ADR body to retire; consolidated-ADR git tag `adr-legacy-2026-06-23` and `../history/ADR-MAPPING.md` record the spec→ADR mapping. 번호 재사용 금지.

Cross-ref: **005** (사용량 집계 · email canonical key — 권위 있는 비용/청구 정본), 006 (공유 자격증명·Local Mode), 008 (예산 집행).
