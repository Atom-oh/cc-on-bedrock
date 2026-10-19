# Lambda Source Module

Python Lambda handlers, packaged by Terraform (`archive_file`) — **not** under any IaC dir.
Current truth: `docs/decisions/BASELINE.md` + `docs/architecture.md` (SSOT).

## Handlers (by decision)
- `user-role-provisioner.py` · `cognito-provisioner-trigger.py` · `role_factory.py` — provisioning + deprovision fan-out (ADR-010, ADR-004).
- `sts-issuer.py` — Local Mode STS issuer, 1h creds, credential_process renewal (ADR-006).
- `bedrock-usage-tracker.py` · `otel-metrics-rollup.py` / `otel_rollup.py` — usage metering (Inference Profile + Invocation Log → DynamoDB) + OTel rollup (ADR-005, ADR-009). **rollup (P1 rewrite 2026-06-26):** parses **native Claude Code OTEL** — `claude_code.*` metrics (S3 `otlp-metrics/`) + scrubbed `tool_result`/`tool_decision` events (S3 `otlp-logs/`) → DynamoDB `USER#email` daily `PROD#`/`SKILL#`/`AGENT#`/`TOOL#`/`ACTIVE#` (per-chunk TTL `OTELOBJ#` dedup). cost/token stays 005.
- `budget-check.py` · `token-limit-enforcer.py` · `limit-reset.py` — budget/limit enforcement → IAM deny (ADR-008). `budget-check` enforces per-user daily / weekly / monthly USD caps (`_effective_user_limits`, `evaluate_user_budget`; any one exceeded blocks; UTC windows — token-limit-enforcer periods are KST) plus the dept monthly cap. Migration note: before this change a user `monthlyBudget` acted as a daily cap; it is now month-to-date and the daily cap comes from `dailyBudget` / dept `perUserDailyBudget` / `DAILY_BUDGET_USD` — review existing budget rows when upgrading.
- `ec2-idle-stop.py` · `idle-check.py` — idle stop / hibernate schedules (ADR-002).
- `nginx-config-gen.py` — per-user nginx routing config from DynamoDB stream (ADR-003).
- `devenv-session-validator/` — CloudFront viewer-request edge auth (NextAuth JWE; ADR-003/004).
- `audit-logger.py` — CloudTrail Bedrock inference events → `cc-prompt-audit` (one row per call, `{eventTime}#{eventID}` key, `client_tool` claude-code|codex from userAgent, Local + EC2 roles plus account-wide `mode=other`, error events kept, Responses shadow event skipped; ADR-014).
- `gateway-manager.py` — supporting handler.
- ADR-014 (Codex on Bedrock): `bedrock-usage-tracker.py` normalizes `*.openai.` IDs, prices GPT models with explicit cache rates and writes a `tool` attribute; `token-limit-enforcer.py` weights = tracker list price ÷ $15 for every model (Claude + GPT, test-enforced); `role_factory.py`/`user-role-provisioner.py` grant OpenAI GPT + `project/default`.

## Rules
- Lambda source lives here (repo root `lambda/`), Terraform packages it. Do not move under `terraform/`.
- A handler change that reflects a decision change must update the relevant ADR + `BASELINE.md` §3 in the same PR (anti-drift).
- `_archived/` and `*-built` artifacts are not active sources.
