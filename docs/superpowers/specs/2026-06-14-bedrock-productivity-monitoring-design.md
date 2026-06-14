# Design: Productivity & Engagement Monitoring for Claude Code on Bedrock

- **Date:** 2026-06-14
- **Status:** Draft (pending user review)
- **Scope:** Areas 1 (productivity/engagement) + 3 (cost depth) of the 1P-dashboard parity effort
- **Related:** ADR-029 (email canonical key), ADR-011 (Bedrock IAM cost allocation), ADR-014/015 (Local Governance, budget/token integration)

## 1. Problem & Motivation

The reference 1P dashboard (`whchoi98/claude-code-dashboard`) derives its richest
insights — DAU/WAU/MAU, sessions, lines-of-code, commits, PRs, tool-acceptance rate,
productivity score, and per-skill/agent cost attribution — from Anthropic's
**Analytics / Admin / Compliance APIs**. Those APIs **do not exist for Amazon Bedrock**.

cc-on-bedrock today is *cost- and governance-rich* (per-user IAM enforcement, dollar
budgets, normalized token limits, email-keyed usage table) but *productivity- and
engagement-blind*. This design closes that gap **without** the Anthropic APIs.

### Key insight (confirmed)

The productivity/engagement metrics are emitted by **Claude Code's client-side
OpenTelemetry**, not by any Anthropic API. They fire identically regardless of backend
(Bedrock / Vertex / 1P). The data source is therefore available to us.

## 2. Phase 0 Spike — Empirical Validation (done 2026-06-14)

A real Claude Code session (v2.1.177) was run **against Bedrock** (Haiku 4.5,
ap-northeast-2) with `OTEL_METRICS_EXPORTER=console`, exercising a file write + git
commit. Findings:

1. **Productivity metrics fire on Bedrock.** Observed: `claude_code.session.count`,
   `lines_of_code.count` (with `type=added/removed` **and** `model=...`),
   `commit.count`, `active_time.total`, `code_edit_tool.decision`, `token.usage`,
   `cost.usage`. (`pull_request.count` fires only when a PR is actually created.)
2. **Native identity is stripped on Bedrock.** `user.email`, `user.account_uuid`,
   `organization.id` = **0 occurrences**; only a 64-char anonymous `user.id` and
   `session.id` are present. → Per-user attribution **must be injected**.
3. **Injection works.** `OTEL_RESOURCE_ATTRIBUTES="enduser.id=<email>,department=<dept>"`
   appears on **every** metric datapoint, e.g.:
   ```
   claude_code.lines_of_code.count
     enduser.id: spike-test@example.com   department: platform-spike
     type: added   model: claude-haiku-4-5-20251001   value: 2
   ```
   The `enduser.id` value is the same email used as the canonical key in ADR-029 →
   productivity metrics join to the existing cost table with **zero transformation**.
4. **Nuance:** datapoints repeat per export interval. The rollup must pin
   `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` and **sum deltas** (never
   take last-value).

**Conclusion: GO.** Every load-bearing assumption is verified against real Bedrock.

## 3. Goals / Non-Goals

**Goals**
- Per-user & per-department productivity metrics (LOC, commits, PRs, sessions,
  active time, tool-acceptance rate) on Bedrock.
- Engagement: DAU/WAU/MAU and adoption over time.
- Cost depth: per-skill / per-agent / per-model cost attribution (area 3), joined to
  the existing authoritative cost table.
- Reuse the existing Next.js dashboard + DynamoDB + ADR-029 email key.
- **Never log prompt/text/image content.** Metrics carry counters only.
- Avoid CloudWatch Logs as a high-volume sink (cost).

**Non-Goals (this phase)**
- The audit/SIEM layer (OTel *events* → S3 + Athena). Deferred to a later phase.
- A "productivity score" formula beyond reproducing the documented 1P weighting.
- Replacing the existing Bedrock-invocation-log cost pipeline (it stays authoritative).

## 4. Architecture — Option A (Collector → DynamoDB, email-keyed)

Chosen over B (Managed Prometheus + Grafana → 2nd dashboard) and C (CloudWatch
metrics/EMF → the expensive sink we must avoid). A multi-model panel (Claude + Codex +
Gemini) concurred on A.

```
Claude Code (EC2/ECS DevEnv + Local PC)
  │  CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_METRICS_EXPORTER=otlp
  │  OTEL_RESOURCE_ATTRIBUTES=enduser.id=<email>,department=<dept>   ← injected
  ▼  (OTLP/gRPC over TLS, authenticated)
OTel Collector  (ECS service, ≥2 tasks / multi-AZ, behind LB, autoscaled)
  │  - batch + aggregate processors (pre-aggregate; drop raw)
  │  - identity processor: overwrite/normalize enduser.id where verifiable
  ▼
Durable buffer  (Kinesis Firehose or SQS)
  ▼
Rollup Lambda  (delta-sum → daily buckets; presence records; identity cross-check)
  ▼
DynamoDB  (existing usage table family, keyed USER#{email})
  ▼
Next.js dashboard  (new productivity/engagement pages + cost-join drill-downs)
```

### 4.1 Amendments mandated by the panel (all adopted)

1. **HA collection.** The collector is an **ECS service (≥2 tasks across AZs) behind a
   load balancer with autoscaling**, not a single Fargate task (SPOF). A durable buffer
   (Firehose/SQS) sits before the rollup Lambda so an ingest spike or Lambda failure
   cannot drop data.
2. **Client identity is UNVERIFIED.** `OTEL_RESOURCE_ATTRIBUTES` is user-settable,
   especially on local PCs. Mitigations:
   - On EC2/ECS the collector **overwrites** `enduser.id` from a trusted source where
     possible (instance IAM/role tag → subdomain → email, per existing tracker logic).
   - The rollup Lambda **cross-checks** OTel identity against Bedrock invocation logs
     (the source of truth). Mismatches (e.g. high LOC with zero Bedrock usage) are
     flagged "unverified/suspicious" in the dashboard.
   - Local-PC metrics are inherently self-reported; this is documented as a known
     trust boundary, not a silent assumption.
3. **Pre-aggregate; no raw rows.** The collector aggregates before the buffer; the
   rollup writes **only daily rollups + presence records** to DynamoDB. Raw datapoints
   are never persisted (avoids WCU/storage blowup).

## 5. Data Model (DynamoDB, alongside existing usage table)

Daily productivity rollup (keyed by the ADR-029 email key):
```
PK = USER#{email}     SK = PROD#{date}#{model}
  attrs: loc_added, loc_removed, commits, prs, sessions, active_seconds,
         edit_accept, edit_reject, dept, updated_at
```
Engagement presence (for DAU/WAU/MAU unique-window counts):
```
PK = USER#{email}     SK = ACTIVE#{date}        (one per active day)
GSI (by date): PK = DAY#{date}  SK = USER#{email}   ← window aggregation
```
Cost attribution (area 3, OTel-sourced, approximate):
```
PK = USER#{email}     SK = ATTR#{date}#{skill|agent|model}
  attrs: cost_usd_est, tokens_in, tokens_out, dept
```
DAU/WAU/MAU are computed in the Next.js API layer by counting distinct `USER#{email}`
over the last 1/7/30 days of presence records (panel confirmed DynamoDB is suitable at
internal-org scale; Prometheus not needed).

## 6. Cost Reconciliation (two costs, clearly labeled)

| Label | Source | Use |
|---|---|---|
| **Billed cost** | Bedrock invocation log → DynamoDB (existing, ADR-011/029) | Authoritative; budgets, finance |
| **Attributed cost** | OTel `cost.usage` (approximate) | Per-skill/agent/model drill-down only; shown with an "estimate" disclaimer |

The dashboard never mixes them in one number; "Billed" is the budget-facing figure,
"Attributed" lives inside productivity drill-downs.

## 7. Identity Injection Mechanism

- **EC2/ECS DevEnv:** inject via the managed `settings.json` (`env` block) or the
  launch wrapper, deriving `enduser.id` = the user's email (ADR-029) and `department`
  from the existing EC2 tag / Cognito attribute resolution already in
  `bedrock-usage-tracker.py`.
- **Local Governance:** inject via the install script / managed settings pushed
  through the STS issuer flow (ADR-014). The collector OTLP endpoint must be a
  TLS-authenticated public endpoint.

## 8. Phasing

- **Phase 0 — Spike (DONE):** validate doc vs reality. ✅
- **Phase 1 — Collect:** OTel Collector ECS service + identity injection (EC2/ECS
  first) + buffer + rollup Lambda + DynamoDB rollups. Reconcile against Bedrock logs.
- **Phase 2 — Visualize:** Next.js productivity/engagement pages (DAU/WAU/MAU, LOC,
  commits/PRs, acceptance, productivity score) + cost-join drill-downs.
- **Phase 3 — Local Governance coverage** + collector identity-overwrite hardening.
- **Later — Audit/SIEM:** OTel *events* → S3 + Athena (not CloudWatch Logs).

## 9. Risks & Open Questions

- **Identity tampering on local PCs** — mitigated, not eliminated; documented trust
  boundary. Cross-check + flagging is the backstop.
- **Temporality handling** — must pin `delta` and sum; verify under OTLP (spike used
  console exporter). Confirm in Phase 1.
- **Collector cost/scale** — size the ECS service; confirm Firehose vs SQS for the
  buffer against expected fan-in.
- **Exact ap-northeast-2 pricing** — confirm DynamoDB write volume and any AMP/Firehose
  costs at Phase 1 design time.
- **`pull_request.count` coverage** — only fires on actual PR creation via shell/MCP;
  acceptable, note in dashboard.

## 10. Decision

Adopt **Option A** with the three panel amendments. Proceed to an implementation plan
(writing-plans) for Phase 1 once this design is approved.
