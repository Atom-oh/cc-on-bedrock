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

**EC2 DevEnv enables native Claude Code OpenTelemetry (metrics + tool events). A collector exports both signals to S3; a rollup Lambda aggregates per-user daily usability KPIs into DynamoDB. Bedrock token/cost stays authoritative in the 005 Invocation Log → DynamoDB pipeline.**

> **P1 rewrite (2026-06-26):** the original custom `cc-otel-code-metrics.sh` shell emitter
> (claude/git wrappers + heartbeat) is **retired**. It could not see tool/skill/subagent
> usage. We pivoted to **native Claude Code OTEL** (`claude_code.*` metrics + `tool_result`/
> `tool_decision` log events), which is the only way to measure skill/agent usage on Bedrock
> (no 1P Analytics API). T0 empirically confirmed the shape on Bedrock.

- **Emit (native OTEL).** Devenvs set `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER=otlp` + `OTEL_LOGS_EXPORTER=otlp` + `OTEL_LOG_TOOL_DETAILS=1`. Metrics give sessions/active-time/LOC/commits/PRs/edit-decisions; `tool_result`/`tool_decision` events give per-skill (`skill_name`) / per-agent (`subagent_type`) / per-tool usage.
- **Transport: OTLP/HTTP :4318 (not gRPC).** OTLP gRPC/HTTP2 over the L4 NLB is unreliable
  ("failed to receive server preface", DNS-multi-IP + keepalive issues) and the Claude Code
  OTEL SDK exposes no gRPC keepalive/round_robin knobs; HTTP export is one independent
  request per batch and works cleanly through the NLB. Devenv, NLB listener/target-group,
  and collector receiver all use 4318.
- **Log filter: `tool_name` attribute, not `event.name`.** OTLP puts the event name in the
  LogRecord's top-level `event_name` field, not in `attributes["event.name"]` — an
  `event.name`-keyed filter silently drops every record (confirmed empirically). The
  collector instead keeps records where `attributes["tool_name"]` is present, which only
  `tool_result`/`tool_decision` currently emit.
- **Pipeline.** Collector (otel-contrib) → `awss3` (metrics + logs prefixes) → S3 `otel_raw` → `otel-metrics-rollup` Lambda → DynamoDB `cc-on-bedrock-usage` (`PROD#`/`SKILL#`/`AGENT#`/`TOOL#`/`ACTIVE#`, per-user email-keyed daily ADD counters; `OTELOBJ#` TTL dedup).
- **Identity.** `enduser.id` is stamped from the provisioned email via `OTEL_RESOURCE_ATTRIBUTES` (native `user.email` is OAuth-only / absent on Bedrock). ADR-029 canonical lowercased-email key; invalid → `unattributed`.
- **Privacy / DLP (no-content).** `OTEL_LOG_TOOL_DETAILS=1` would log bash commands / file paths / prompts; the **collector logs pipeline scrubs** them — keeps only `tool_result`/`tool_decision`, lifts `skill_name`/`subagent_type` to top-level, deletes `tool_parameters`/`tool_input`/`prompt`/`response` before S3. No prompt/text/image content is ever persisted.
- **Authoritative cost stays 005.** Per-skill/agent/model cost remains an OTel-based estimate; authoritative billing stays in the 005 invocation-log pipeline. The rollup writes no cost/token rows.

후속(P2/P3): Productivity/Economic Score 계산·7일 트렌드·AI 진단(`/api/ai`)·대시보드 UI. 운영 follow-up: collector 통일(ecs-devenv awsemf collector 폐기 후 devenv 엔드포인트를 awss3 collector로 일원화).

## Consequences

긍정 / Positive
- Anthropic 1P Analytics API 없이 Bedrock 위에서 참조 대시보드급 KPI(session/active-time/LOC/commit/PR/edit-decision + **per-skill/per-agent/per-tool 사용량**) 가시성 확보.
- 커스텀 wrapper/heartbeat 제거 → 설치 표면·드리프트 감소. 네이티브 OTEL이 정확도·tool 가시성 제공.

부정·위험 / Negative & risk
- Local PC telemetry is optional because the default Collector endpoint is internal. If a public OTLP endpoint is configured later, local identity remains self-reported and must not become an authoritative billing/control signal.
- 네이티브 `commit.count`/`lines_of_code.count`는 Claude Code가 관측한 활동 기준이라, 터미널에서 수동으로 친 git 커밋 일부는 포함되지 않을 수 있다(usability=Claude 사용 범위 기준으로 수용).
- skill/agent 측정은 `OTEL_LOG_TOOL_DETAILS=1`에 의존하며, 민감필드는 **collector scrub**에 신뢰를 둔다(scrub 실패 시 content 유출 위험 → config 테스트로 보장).

보안 / Security
- 내용(prompt/text/image) 무로깅, counter-only. OTLP는 TLS·인증 엔드포인트.
- 0.0.0.0/0 · Principal:"*" · 평문 시크릿 도입 없음. email 키 처리는 005/ADR-031 불변식 준수.

## Consolidates

선행 번호 ADR 없음 (no prior numbered ADR). 이 ADR은 설계 스펙 `docs/superpowers/specs/2026-06-14-bedrock-productivity-monitoring-design.md`(Productivity & Engagement Monitoring, Option A)를 공식화한다.

This ADR formalizes the design spec `docs/superpowers/specs/2026-06-14-bedrock-productivity-monitoring-design.md`. There is no legacy ADR body to retire; consolidated-ADR git tag `adr-legacy-2026-06-23` and `../history/ADR-MAPPING.md` record the spec→ADR mapping. 번호 재사용 금지.

Cross-ref: **005** (사용량 집계 · email canonical key — 권위 있는 비용/청구 정본), 006 (공유 자격증명·Local Mode), 008 (예산 집행).
