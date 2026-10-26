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
Runtime-verified 2026-10-18 through a provisioned per-user Local role
(`cc-on-bedrock-local-user-demo`): Codex + Claude Code usage rows, audit rows, budget deny
attach → explicit deny → release, and the `project/default` narrowing. Static checks below.

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

**Codex calls Bedrock through `amazon-bedrock-runtime` by default and shares Claude Code's
per-user roles, usage pipeline, budget deny and audit path. bedrock-mantle is used only as
the opt-in `codex -p mantle` profile for users whose cost is unlimited (§9, amended 2026-10-26).**

1. **IAM (extends ADR-007).** Every per-user Bedrock allow-list and the permission
   boundary add `foundation-model/*openai.gpt-*`, `inference-profile/*openai.gpt-*` and
   `arn:aws:bedrock:*:{acct}:project/default` (verified live 2026-10-18: Codex succeeds with only `project/default`; the Responses API also authorizes
   `bedrock:InvokeModel` on the account default project). The six copies
   (`security/main.tf` shared document + boundary, `ec2-devenv/main.tf`,
   `role_factory.py`, `user-role-provisioner.py`, `ec2-clients.ts`) are pinned by
   `tests/unit/test_bedrock_iam_codex_parity.py`. The dashboard's own role stays
   Claude-only. None of these copies grants `bedrock-mantle:*`; the mantle grant is the
   separate, budget-check-managed policy of §9.
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
4. **Local Mode.** `cc-bedrock-local setup` (run by the installer) writes the governed
   defaults into `~/.codex/config.toml`: provider, model, `web_search = "disabled"` and
   `[model_providers.amazon-bedrock-runtime.aws]` with `profile` = the `credential_process`
   profile and region, plus `default_permissions` = a `cc-bedrock` profile
   (`extends = ":workspace"`) that denies `~/.config/cc-bedrock` (refresh token, STS
   keys) to sandboxed commands — skipped with a warning when the user already chose a
   `sandbox_mode`/`default_permissions`. Each line is marked `# managed by cc-bedrock-local`.
   Plain `codex` then signs with the per-user role (verified with codex-cli 0.163). Claude Code's
   `awsCredentialExport` runs the same `credential-process` subcommand: it accepts the flat
   `credential_process` shape (`Version`/`AccessKeyId`/…/`Expiration`) as well as
   `{"Credentials":…}` (Claude Code settings docs; verified 2026-10-26 with `claude -p` answering
   from Bedrock), and caches it until 5 min before `Expiration`. The file is the user's,
   so pointing it back at OpenAI only leaves the platform; it cannot spend Bedrock outside
   the role, which stays the enforcement point. `cc-bedrock-local codex` still pins
   provider and region as session overrides (`-c`) for a one-off governed run.
   The provider stays `amazon-bedrock-runtime`, not `amazon-bedrock` (bedrock-mantle, see
   Context). *Amended 2026-10-26:* the installer no longer adds the `ccx`/`cc` shell functions.
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
   All normalized-token weights (Claude and GPT) = list price ÷ $15, derived from the tracker's
   `PRICING` / `FAMILY_PRICING`, so the USD→token mirror (`NORMALIZED_PER_USD=66667`) agrees
   with the USD budget it mirrors. Claude weights were rescaled with the price correction;
   production had no normalized-token `LIMIT#` rows, so no configured limit changed meaning.
8. **Audit.** `audit-logger` accepts `Responses`, skips the shadow event, resolves Local
   Mode roles (previously `unknown`), records `client_tool` from the CloudTrail userAgent
   (vendor fallback), and keys rows `{eventTime}#{eventID}` so same-second calls no longer
   overwrite each other. Audit stays account-wide: non-platform principals are recorded with `mode=other`, and error events are kept with `error_code`. The Security
   page tags Bedrock audit rows Claude Code / Codex with the model.

9. **bedrock-mantle for unlimited users (amended 2026-10-26).** Users need mantle-only
   APIs, above all server-side **web search**, which bedrock-runtime lacks. Mantle traffic
   never reaches the invocation log, so it cannot be metered per user. Decision (user): mantle
   is available **only while a user's cost is unlimited** and every surface says it is
   **not counted** in usage or budget.
   - *Eligibility* (`budget-check`, every 5 min): every effective USD cap (user → dept
     per-user default → global) is 0, the department total budget is 0, and no `LIMIT#`
     token row exists for the user or department. With the shipped global `daily_budget_usd`
     > 0 nobody is eligible.
   - *Grant:* inline policy `cc-bedrock-mantle-unmetered` on `cc-on-bedrock-local-user-*`:
     `bedrock-mantle:CreateInference`/`Get*`/`List*` on the user's **own** us-east-1 project
     (`cc-<subdomain>`, created by budget-check, never auto-archived) + `bedrock-websearch:
     InvokeSearch`/`InvokeFetch`. Scoping to the own project makes the `OpenAI-Project`
     header mandatory (`project/default` is denied). Removed within one run when any cap
     appears; on a budget/limits/Cognito read failure every grant is removed (fail safe).
     The permission boundary carries the matching ceiling behind `enable_mantle`; every
     deny policy also denies `bedrock-mantle:*` and `bedrock-websearch:*`.
   - *Client:* `/api/local/credentials` (sts-issuer) reports `mantle {enabled, projectId,
     region, model}` read from the grant; `cc-bedrock-local` writes / removes
     `~/.codex/mantle.config.toml` (Codex 0.163 loads `-p <name>` from `<name>.config.toml`
     and rejects `[profiles.<name>]` in config.toml) on login, credential renewal and setup.
     Plain `codex` stays on bedrock-runtime (Seoul). GPT models exist on mantle only in
     **us-east-1** (Codex refuses Seoul mantle client-side), so mantle data is processed there.
   - *Audit:* a us-east-1 trail logs mantle data events (`AWS::BedrockMantle::Project`,
     ~$0.10 / 100k calls) to its own bucket (90 days); an EventBridge rule forwards
     `CreateInference` to the home-region bus, where `audit-logger` records it with
     `provider = mantle`, `metered = false`.
   - Terraform: `enable_mantle` (default true; false = no ceiling, no trail, no grant) and
     `codex_mantle_model_id` (default `openai.gpt-6.1-sol`). EC2 DevEnv mantle is a follow-up.

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
      - "for_each = var.enable_mantle ? [1] : []"
  - path: lambda/budget-check.py
    must_contain:
      - "def mantle_eligible"
      - "cc-bedrock-mantle-unmetered"
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
  - claim: "Codex defaults to the bedrock-runtime Responses API (amazon-bedrock-runtime provider), so invocation-log metering, the IAM deny and audit cover it; bedrock-mantle is granted only to unlimited-cost users, scoped to their own project, revoked when any cap appears, and audited via CloudTrail data events."
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
