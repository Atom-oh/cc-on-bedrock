# Lambda Source Module

Python Lambda handlers, packaged by Terraform (`archive_file`) — **not** under any IaC dir.
Current truth: `docs/decisions/BASELINE.md` + `docs/architecture.md` (SSOT).

## Handlers (by decision)
- `user-role-provisioner.py` · `cognito-provisioner-trigger.py` · `role_factory.py` — provisioning + deprovision fan-out (ADR-010, ADR-004).
- `sts-issuer.py` — Local Mode STS issuer, 1h creds, credential_process renewal (ADR-006).
- `bedrock-usage-tracker.py` · `otel-metrics-rollup.py` / `otel_rollup.py` — usage metering (Inference Profile + Invocation Log → DynamoDB) + OTel rollup (ADR-005, ADR-009). **rollup (P1 rewrite 2026-06-26):** parses **native Claude Code OTEL** — `claude_code.*` metrics (S3 `otlp-metrics/`) + scrubbed `tool_result`/`tool_decision` events (S3 `otlp-logs/`) → DynamoDB `USER#email` daily `PROD#`/`SKILL#`/`AGENT#`/`TOOL#`/`ACTIVE#` (per-chunk TTL `OTELOBJ#` dedup). cost/token stays 005.
- `budget-check.py` · `token-limit-enforcer.py` · `limit-reset.py` — budget/limit enforcement → IAM deny (ADR-008).
- `ec2-idle-stop.py` · `idle-check.py` — idle stop / hibernate schedules (ADR-002).
- `nginx-config-gen.py` — per-user nginx routing config from DynamoDB stream (ADR-003).
- `devenv-session-validator/` — CloudFront viewer-request edge auth (NextAuth JWE; ADR-003/004).
- `audit-logger.py`, `gateway-manager.py` — supporting handlers.

## Rules
- Lambda source lives here (repo root `lambda/`), Terraform packages it. Do not move under `terraform/`.
- A handler change that reflects a decision change must update the relevant ADR + `BASELINE.md` §3 in the same PR (anti-drift).
- `_archived/` and `*-built` artifacts are not active sources.
