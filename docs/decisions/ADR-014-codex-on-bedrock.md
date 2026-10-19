---
status: Accepted
date: 2026-10-18
verification_required: true
runtime_required: false
related: [ADR-005, ADR-006, ADR-007, ADR-008, ADR-009]
builds_on: ADR-005
---

# ADR-014: Codex on Bedrock (OpenAI Codex CLI via the bedrock-runtime Responses API)

## Status

Accepted, 2026-10-18. Lifts the BASELINE §2 `DEFERRED · Codex on Bedrock` entry.
Static verification below; a live call through a provisioned per-user role (the
narrowed ARN set) is a post-deploy check (see Runtime).

## Context

The platform governed only Claude Code on Bedrock. Users also want the OpenAI Codex
CLI under the same per-user IAM, usage, budget and audit controls. Codex CLI (0.163+)
ships two built-in Bedrock providers, which differ in what governance sees:

| | `amazon-bedrock` (bedrock-mantle) | `amazon-bedrock-runtime` (bedrock-runtime) |
|---|---|---|
| Endpoint | `bedrock-mantle.{region}.api.aws` | `bedrock-runtime.{region}.amazonaws.com/openai/v1` |
| IAM action | `bedrock-mantle:CreateInference` | `bedrock:InvokeModel*` (target **and** default project) |
| CloudTrail | **data event** (off by default, billed) | management event (default, free) |
| Model invocation logging | no (CloudWatch `AWS/BedrockMantle`, account/project/model only) | **yes**, same as Converse/InvokeModel |

Existing pipelines key off the second column: the usage tracker (ADR-005) reads the
invocation log's `identity.arn` + token counts, the deny policies (ADR-008) cover
`bedrock:InvokeModel*`/`Converse*`, and the audit logger consumed four CloudTrail
event names for EC2 task roles only.

Evidence (samples account, ap-northeast-2, 2026-10-18):
- `codex exec -c model_provider=amazon-bedrock-runtime -c model=global.openai.gpt-6.1-sol`
  succeeded (also `gpt-5.5`, `gpt-6-luna`) with AWS SDK chain credentials — no API key,
  no OpenAI account.
- Invocation log record: `operation="Responses"`, `modelId=arn:…:inference-profile/global.openai.gpt-5.5`,
  `identity.arn`, `input.inputTokenCount`/`cacheRead…`/`cacheWrite…`, `output.outputTokenCount`.
- CloudTrail: `Responses` (`requestParameters.modelId`, userAgent `codex_exec/0.163.0 …`,
  `additionalEventData.inferenceRegion`) plus a shadow `InvokeModelWithResponseStream`
  with `requestParameters: null`. Claude Code's userAgent is `claude-cli/2.1.302 (external, sdk-cli)`.
- `global.openai.gpt-{5.4,5.5,5.6-sol,5.6-terra,5.6-luna,6-astra,6-sol,6-luna,6.1-sol}`
  profiles are listed in ap-northeast-2.

## Decision

**Codex calls Bedrock only through `amazon-bedrock-runtime` and shares Claude Code's
per-user roles, usage pipeline, budget deny and audit path. bedrock-mantle is not used.**

1. **IAM (extends ADR-007).** Every per-user Bedrock allow-list and the permission
   boundary add `foundation-model/*openai.gpt-*`, `inference-profile/*openai.gpt-*` and
   `arn:aws:bedrock:*:{acct}:project/default` (verified live 2026-10-18: Codex succeeds with only `project/default`; the Responses API also authorizes
   `bedrock:InvokeModel` on the account default project). The six copies
   (`security/main.tf` shared document + boundary, `ec2-devenv/main.tf`,
   `role_factory.py`, `user-role-provisioner.py`, `ec2-clients.ts`) are pinned by
   `tests/unit/test_bedrock_iam_codex_parity.py`. The dashboard's own role stays
   Claude-only. No `bedrock-mantle:*` grant, so the mantle path cannot bypass metering.
   Existing roles pick up the change on their next inline-policy upsert (Local: STS
   issue; EC2: instance create/restore/start — the restart path now re-upserts too).
2. **Models and attribution.** The Responses API rejects foundation-model IDs and
   **application inference profiles**, so Codex names system cross-Region profiles
   (`global.openai.*`) and usage is attributed by the per-user role identity in the
   invocation log (as Claude Code is in practice). Default model: Terraform
   `codex_model_id` = `global.openai.gpt-6.1-sol` (Global CRIS $2/$10).
3. **DevEnv install.** `@openai/codex` via npm (AMI `setup-codex.sh`, refreshed on boot by
   `cc-cli-update.service`, healed by `postStartSetup`). Governed defaults go to the
   **system layer** `/etc/codex/config.toml` (lowest precedence; users may override keys
   in `~/.codex/config.toml`): provider, region, model, `web_search = "disabled"`
   (bedrock-runtime has no server-side tools), `[analytics] enabled = false`.
4. **Local Mode.** `cc-bedrock-local codex` (installer function `ccx`) runs Codex on the
   same `credential_process` profile and pins provider and region as session overrides
   (`-c`), which outrank a personal `~/.codex/config.toml` pointing at OpenAI (verified).
   The model override applies only when the user passes no `-m`/`--model`.
5. **Cost (extends ADR-005).** `normalize_model` strips `*.openai.` prefixes
   (`gpt-6.1-sol`). `PRICING` carries **explicit cache read/write rates** per model,
   because vendors differ (GPT-6.1 Sol cache read is 0.05× input, Anthropic 0.1×).
   Unlisted GPT models fall back to a tier family (astra/sol/terra/luna/gpt), never the
   Sonnet default. Sources: AWS Price List API (`AmazonBedrockFoundationModels`,
   ap-northeast-2 `*_global_standard`) and the Bedrock model cards' Global CRIS rows.
   The same check showed the Claude table was stale and it is corrected
   (Opus 4.8 $15/$75 → $5/$25, Sonnet 5 $3/$15 → $2/$10, Haiku 4.5 $0.80/$4 → $1/$5).
6. **Tool attribution.** Usage rows get a `tool` attribute (`claude-code`|`codex`|`other`,
   from the model vendor; readers derive it for older rows). Dashboard:
   `/api/usage?action=tool_summaries` and an Analytics "usage by tool" section.
7. **Budgets and limits (ADR-008).** Dollar budgets use the per-model cost unchanged, so
   Codex spend counts against the same user/department budgets. The existing deny
   policies (`Resource: "*"`, `bedrock:InvokeModel*`) already block Responses calls.
   Normalized-token weights gain GPT tiers (list price ÷ $15). **Claude weights are not
   rescaled** — that would silently loosen admin-configured token limits.
8. **Audit.** `audit-logger` accepts `Responses`, skips the shadow event, resolves Local
   Mode roles (previously `unknown`), records `client_tool` from the CloudTrail userAgent
   (vendor fallback), and keys rows `{eventTime}#{eventID}` so same-second calls no longer
   overwrite each other. Audit stays account-wide: non-platform principals are recorded with `mode=other`, and error events are kept with `error_code`. The Security
   page tags Bedrock audit rows Claude Code / Codex with the model.

## Consequences

- Positive: Codex usage, cost, budget enforcement and audit reuse the existing tables and
  Lambdas; no API keys to issue or store; no CloudTrail data-event cost. Claude cost
  display now matches list prices.
- Negative: no Codex productivity KPIs (ADR-009 rollup parses `claude_code.*` only;
  cost/tokens are unaffected because the invocation log is authoritative) — follow-up.
  bedrock-runtime lacks server-side tools and background mode. Codex may warn
  `Model metadata … not found` for Bedrock profile IDs (fallback metadata, works).
  Price tables are manual (unknown SKUs are priced conservatively by family).
  Correcting Claude prices lowers displayed Opus cost to ~1/3 of before, so the same
  dollar budget allows more Opus use — an intended correction that needs an operator notice.
- Mitigations: price sources and verification date live in the `PRICING` comment and
  `tests/unit/test_usage_tracker_pricing.py` pins key rates; IAM drift is caught by the
  parity test and default-model drift by `tests/unit/test_model_id_consistency.py`.
  Operator guide: `../runbooks/codex-cost-budget-audit.md`.

## Verification

```yaml
files:
  - path: terraform/modules/security/main.tf
    must_contain:
      - "foundation-model/*openai.gpt-*"
      - ":project/default"
    must_not_contain:
      - "bedrock-mantle:"
  - path: lambda/bedrock-usage-tracker.py
    must_contain:
      - "global.openai."
      - "\"gpt-6.1-sol\""
      - "def tool_for_model"
  - path: lambda/audit-logger.py
    must_contain:
      - "'Responses'"
      - "cc-on-bedrock-local-user-"
  - path: terraform/modules/usage-tracking/main.tf
    must_contain:
      - "\"Responses\""
  - path: tools/cc-bedrock-local.sh
    must_contain:
      - "model_provider=\"amazon-bedrock-runtime\""

semantic:
  - claim: "Codex uses the bedrock-runtime Responses API (amazon-bedrock-runtime provider), never bedrock-mantle, so invocation-log metering, the IAM deny and management-event audit cover it."
    context_files:
      - shared/nextjs-app/src/lib/ec2-clients.ts
      - tools/cc-bedrock-local.sh
      - lambda/bedrock-usage-tracker.py

# runtime:
#   - kind: bedrock-invoke
#     description: "Codex through a provisioned cc-on-bedrock-local-user-* role succeeds; with a deny attached it gets AccessDenied"
#     role_arn: "arn:aws:iam::${ACCOUNT_ID}:role/cc-on-bedrock-local-user-<test>"
#     model_ids: ["global.openai.gpt-6.1-sol"]
#     expect: success
```

## References

- AWS: Responses API — bedrock-runtime vs bedrock-mantle, permissions, invocation logging
  (`docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html`)
- AWS: Monitor bedrock-mantle API calls using CloudTrail (`…/logging-cloudtrail-mantle.html`)
- Codex config reference (`model_providers.amazon-bedrock*`, `analytics.enabled`) and config
  layering (`/etc/codex/config.toml` is the System layer, lowest precedence)
