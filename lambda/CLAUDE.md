# Lambda Source Module

Python Lambda handlers. Terraform packages them with `archive_file` from this repo-root directory; they do not live under `terraform/`.
Current truth: `docs/decisions/BASELINE.md` + `docs/architecture.md`.

## Handlers (by decision)
- `user-role-provisioner.py` · `cognito-provisioner-trigger.py` · `role_factory.py` — provisioning and deprovision fan-out (ADR-010, ADR-004).
- `sts-issuer.py` — Local Mode STS issuer: 1h credentials, renewed through `credential_process` (ADR-006). Also returns `mantle {enabled, projectId, region, model}` read from the role's `cc-bedrock-mantle-unmetered` policy (ADR-014 §9).
- `bedrock-usage-tracker.py` · `otel-metrics-rollup.py` / `otel_rollup.py` — usage metering (Inference Profile + Invocation Log → DynamoDB, ADR-005) and the OTel rollup (ADR-009). The rollup parses native Claude Code OTel: `claude_code.*` metrics (S3 `otlp-metrics/`) and scrubbed `tool_result`/`tool_decision` events (S3 `otlp-logs/`) → DynamoDB `USER#email` daily `PROD#`/`SKILL#`/`AGENT#`/`TOOL#`/`ACTIVE#` items, deduplicated per chunk with TTL `OTELOBJ#` markers. Cost and tokens remain owned by ADR-005.
- `budget-check.py` · `token-limit-enforcer.py` · `limit-reset.py` — budget and limit enforcement through IAM deny (ADR-008). `budget-check` enforces per-user daily / weekly / monthly USD caps (`_effective_user_limits`, `evaluate_user_budget`; exceeding any one blocks; UTC windows) plus the department monthly cap. token-limit-enforcer periods use KST. `budget-check` also reconciles Codex mantle (`reconcile_mantle`): unlimited-cost users get a per-user us-east-1 mantle project + `cc-bedrock-mantle-unmetered`, everyone else (and everyone on a read failure) loses it; every deny includes `bedrock-mantle:*`/`bedrock-websearch:*` (ADR-014 §9).
  - Upgrade note: a user `monthlyBudget` used to act as a daily cap. It is now month-to-date, and the daily cap comes from `dailyBudget` / dept `perUserDailyBudget` / `DAILY_BUDGET_USD`. Review existing budget rows when upgrading.
- `ec2-idle-stop.py` · `idle-check.py` — idle stop / hibernate schedules (ADR-002); deployed only with `deployment_mode = "devenv"`.
- `nginx-config-gen.py` — per-user nginx routing config from the DynamoDB stream (ADR-003).
- `devenv-session-validator/` — CloudFront viewer-request edge auth (NextAuth JWE; ADR-003/004).
- `audit-logger.py` — CloudTrail Bedrock inference events → `cc-prompt-audit`: one row per call (`{eventTime}#{eventID}` key), `client_tool` claude-code|codex from userAgent, Local + EC2 roles plus account-wide `mode=other`, error events kept, Responses shadow event skipped (ADR-014); bedrock-mantle `CreateInference` (forwarded from us-east-1) recorded with `provider=mantle`, `metered=false`.
- `gateway-manager.py` — supporting handler.
- Codex on Bedrock (ADR-014): `bedrock-usage-tracker.py` normalizes `*.openai.` IDs, prices GPT models with explicit cache rates and writes a `tool` attribute; `token-limit-enforcer.py` weights every model (Claude and GPT) as tracker list price ÷ $15, enforced by tests; `role_factory.py` / `user-role-provisioner.py` grant OpenAI GPT + `project/default`.

## Rules
- Keep sources here; Terraform packages them.
- When a handler change reflects a change in a decision, update the relevant ADR and `BASELINE.md` §3 in the same PR (anti-drift). Handler changes that don't change a decision need no ADR edit.
- `_archived/` and `*-built` artifacts are not active sources.
- Tests: `python3 -m pytest lambda/__tests__ -q` (also run by `tests/run-all.sh`).
