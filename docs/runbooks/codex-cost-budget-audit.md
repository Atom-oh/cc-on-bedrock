# Runbook — Claude Code and Codex: cost, budgets, audit logs

> Audience: platform administrators. Decisions: ADR-005 (usage metering), ADR-008
> (budget enforcement), ADR-014 (Codex on Bedrock). Examples use `ap-northeast-2` and
> administrator credentials for the deployment account.

## 0. Where each answer comes from

| Question | Authoritative source | Latency | Where to look |
|---|---|---|---|
| Who spent how much, with which tool (tokens / USD) | Bedrock **model invocation log** → `bedrock-usage-tracker` → DynamoDB `cc-on-bedrock-usage` | seconds | Dashboard **Analytics → Usage by Tool**, plus user/department sections |
| Is a user blocked by a budget or limit | `budget-check` (5 min) / `token-limit-enforcer` (stream) → IAM deny on the per-user role | ≤ 5 min | **Admin → Budgets / Limits**, `cc-bedrock-local status` |
| Which call happened when and from where (audit) | CloudTrail management events → EventBridge → `audit-logger` → DynamoDB `cc-prompt-audit` | minutes | **Security → Audit logs** (Claude Code / Codex badge), DynamoDB query |
| Financial reconciliation | CUR 2.0 / Cost Explorer (secondary, ADR-005 §4) | ~24 h | Billing console |

Claude Code (Anthropic models) and Codex (OpenAI GPT models) call `bedrock-runtime`
with the **same per-user IAM role**, so all four paths are shared. Codex calls appear
as the Responses API (`operation = "Responses"`).

## 1. Cost

### 1.1 Dashboard
- **Analytics → Usage by Tool (Claude Code vs Codex)**: cost, tokens, requests, user
  count and models per tool for the selected range, plus a cost-share donut. Admins see
  everyone; other users see only their own rows (`/api/usage?action=tool_summaries`).
- The model, user and department sections include Codex models (`gpt-6.1-sol`, …).

### 1.2 Rates (USD per 1M tokens · Standard · Global CRIS · short context ≤ 272K)
The source of truth is `PRICING` in `lambda/bedrock-usage-tracker.py` (its comment
records sources and the verification date). Excerpt as of 2026-10-18:

| Model (normalized) | input | output | cache read | cache write |
|---|---|---|---|---|
| claude-opus-4-8 | 5.00 | 25.00 | 0.50 | 6.25 |
| claude-sonnet-5 | 2.00 | 10.00 | 0.20 | 2.50 |
| claude-haiku-4-5 | 1.00 | 5.00 | 0.10 | 1.25 |
| gpt-6.1-sol (Codex default) | 2.00 | 10.00 | 0.10 | 2.50 |
| gpt-6-luna | 0.10 | 0.50 | 0.01 | 0.125 |
| gpt-6-astra | 10.00 | 50.00 | 1.00 | 12.50 |
| gpt-5.5 | 5.00 | 30.00 | 0.50 | — |

Caveats:
- Requests above 272K input tokens bill at long-context rates (about 2×); the dashboard
  estimates at short-context rates, so very large-context sessions are under-estimated.
  Reconcile against CUR.
- Models missing from the table fall back to a family rate (opus/sonnet/haiku/fable,
  astra/sol/terra/luna/gpt), priced conservatively. When a new SKU ships, add it to
  `PRICING` and update `tests/unit/test_usage_tracker_pricing.py`.
- Re-check prices with `aws pricing get-products --region us-east-1 --service-code
  AmazonBedrockFoundationModels --filters Type=TERM_MATCH,Field=regionCode,Value=ap-northeast-2`
  (Claude and GPT-6 Astra); other GPT models: the "Global CRIS" row of the Bedrock model card.

### 1.3 CLI
```bash
# One user's per-model rows this month (PK = lowercased email)
aws dynamodb query --table-name cc-on-bedrock-usage \
  --key-condition-expression 'PK = :pk AND begins_with(SK, :m)' \
  --expression-attribute-values '{":pk":{"S":"USER#alice@example.com"},":m":{"S":"2026-10"}}' \
  --projection-expression 'SK, #t, estimatedCost, inputTokens, outputTokens, cacheReadTokens' \
  --expression-attribute-names '{"#t":"tool"}'
```
```sql
-- CloudWatch Logs Insights on /aws/bedrock/invocation-logs: Codex calls per user
fields identity.arn as who, modelId, input.inputTokenCount as inTok, output.outputTokenCount as outTok
| filter operation = "Responses"
| stats count(*) as calls, sum(inTok) as input, sum(outTok) as output by who, modelId
| sort input desc
```

## 2. Budgets and limits

### 2.1 Two axes (ADR-008) — exceeding either one blocks
| Axis | Set in | Stored in | Enforced by | Deny policy |
|---|---|---|---|---|
| Department monthly USD | Admin → Budgets (department) | `cc-department-budgets.monthlyBudget` | `budget-check` (5 min) | `cc-bedrock-dept-budget-deny` (all members) |
| User USD — **daily / weekly / monthly** | Admin → Budgets (user, three fields) / department per-user defaults / env `DAILY_BUDGET_USD` (50), `WEEKLY_BUDGET_USD` (0), `MONTHLY_BUDGET_USD` (0) | `cc-user-budgets.{daily,weekly,monthly}Budget` | `budget-check` | `cc-bedrock-user-daily-deny` |
| Normalized tokens (day/week/month) | Admin → Limits | `cc-on-bedrock-limits` `LIMIT#{period}` | `token-limit-enforcer` (stream) | `cc-bedrock-local-token-deny` (Local roles) |

- **Codex counts against the same budgets.** The USD axis uses `estimatedCost` from the
  rates above. The token axis uses GPT tier weights (list price ÷ $15,
  `DEFAULT_WEIGHTS` in `token-limit-enforcer.py`). There is no per-tool budget: a user's
  Claude Code + Codex total is what hits the limit.
- Deny policies cover `bedrock:InvokeModel*` / `Converse*` on `*`, so Codex Responses
  calls (which authorize `bedrock:InvokeModel` on the profile and the default project)
  are blocked too; a blocked Codex session fails with `AccessDeniedException`.
- **User USD caps (ADR-008 amendment 2026-10-18):** set daily, weekly and monthly caps
  per user (e.g. $50 / $100 / $200) or as department per-user defaults. Exceeding **any
  one** blocks; the block lifts only when every period is back under its cap. Windows are
  UTC: day, ISO week (Monday 00:00 UTC), calendar month. 0 / empty = inherit (user) or
  no cap (dept/global). The Budgets → Users table shows `spend / cap` per period and
  `BLOCKED (period) until …`; `cc-bedrock-local status` and the Local page show the same.
- Claude token weights keep their legacy units (Opus 1/5, Sonnet 0.2/1, Haiku
  0.053/0.267) so the ADR-014 price correction does not change what existing token
  limits mean.

### 2.2 User-side check
```bash
cc-bedrock-local status     # deny active / reason / reset_at
```

## 3. Audit logs

### 3.1 What is recorded
- **CloudTrail management events (default, free):** Claude Code →
  `ConverseStream` / `InvokeModelWithResponseStream` (userAgent `claude-cli/…`); Codex →
  `Responses` (userAgent `codex_exec/…` or `codex_cli_rs/…`, `requestParameters.modelId`,
  `additionalEventData.inferenceRegion`) plus a shadow `InvokeModelWithResponseStream`
  whose `requestParameters` is empty.
- **`cc-prompt-audit` (DynamoDB):** one row per call by a platform role
  (`cc-on-bedrock-task-*`, `cc-on-bedrock-local-user-*`): `user_id` (subdomain),
  `timestamp` (`{eventTime}#{eventID}`), `mode` (ec2|local), `client_tool`
  (claude-code|codex|other), `event_name`, `model_id`, `user_agent`, `source_ip`,
  `inference_region`. Shadow events are skipped. **Prompt text is never stored**
  (invocation logging is metadata-only too).
- bedrock-mantle is not granted in IAM (ADR-014), so no mantle data-event path exists.

### 3.2 Queries
- Dashboard **Security → Audit logs**: last 24 h of CloudTrail (Bedrock/Cognito/EC2);
  Bedrock rows carry a Claude Code / Codex badge, hover shows the model ID.
```bash
# One user's audit history, newest first
aws dynamodb query --table-name cc-prompt-audit \
  --key-condition-expression 'user_id = :u AND #ts >= :from' \
  --expression-attribute-names '{"#ts":"timestamp"}' \
  --expression-attribute-values '{":u":{"S":"alice"},":from":{"S":"2026-10-01"}}' \
  --no-scan-index-forward

# Codex calls straight from CloudTrail (90-day event history)
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=Responses \
  --start-time "$(date -u -d '-1 day' +%FT%TZ)" --query 'Events[].[EventTime,Username]' --output text
```

## 4. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Codex `AccessDenied … project/default` | Role or boundary lacks `arn:aws:bedrock:*:{acct}:project/default`. Check `tests/unit/test_bedrock_iam_codex_parity.py` and `terraform apply` (the boundary is Terraform-owned). Existing role inline policies upsert automatically — Local roles on the next STS issue (`role_factory.ensure_role`), EC2 roles on the next instance create/restore/start (`ensureUserInstanceProfile`) |
| Codex `400 … application inference profile` | The Responses API does not accept application inference profiles — use a `global.openai.*` profile |
| Codex usage shows 0 on the dashboard | The invocation-log subscription only passes platform-role `identity.arn`s. Check the user did not run with personal credentials or `OPENAI_API_KEY`; the Codex banner must show `provider: amazon-bedrock-runtime` |
| Usage never appears; Lambda logs show `KMS key access denied` | The Lambda role lacks the `DynamoDbCmk` statement for the table CMK (fixed in Terraform for tracker, budget-check, limit-reset, sts-issuer, token-limit-enforcer, gateway-manager). Any new role that reads/writes the governance tables needs the same statement |
| `Model metadata … not found` warning | Codex has no built-in metadata for Bedrock profile IDs and uses fallback metadata — harmless |
