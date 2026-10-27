# Codex on bedrock-mantle (web search) for unlimited users — design

Date: 2026-10-26 · Branch: `feat/codex-mantle` (stacked on #139 `feat/install-native-clients`)
Amends ADR-014 and the BASELINE §1 invariant "Codex = bedrock-runtime only". No new ADR.

## Intent

Users want both Codex Bedrock providers:

- `amazon-bedrock-runtime` (bedrock-runtime, Seoul): metered, budgeted, audited. It stays the default.
- `amazon-bedrock` (bedrock-mantle): needed for the APIs only mantle serves, such as server-side **web search**.

Mantle traffic does not reach the invocation log, so the usage pipeline cannot meter it per user.
**Decision (user, 2026-10-26):** mantle is available **only to users whose cost is unlimited**.
It is not counted toward usage or budget, and every surface that enables it says so.
Inference audit is **on** (CloudTrail data events, billed).
In Codex, `runtime` is the default and mantle is an opt-in profile (`codex -p mantle`).

## Verified facts (samples account 061525506239, codex-cli 0.163, 2026-10-26)

| Fact | Evidence |
|---|---|
| Mantle GPT models exist **only in us-east-1**. Seoul mantle lists `gpt-oss-*`, `claude-opus-5` and `claude-sonnet-5`, but no `openai.gpt-6*`. Codex refuses `ap-northeast-2`/`ap-southeast-2` client-side, and other regions fail. | `GET /v1/models` per region; codex region probe |
| Codex selects the mantle project with `model_providers.amazon-bedrock.http_headers."OpenAI-Project"`. The `OPENAI_PROJECT` env var is ignored and the call lands in `project/default`. | `AWS/BedrockMantle` `Project=proj_…,Model=openai.gpt-5.6-luna` (header run) vs `Project=default,Model=openai.gpt-6-luna` (env run) |
| Server-side web search works on mantle (`web_search = "live"`). | `codex exec` log shows `web search: …` + cited npmjs URL |
| IAM: `bedrock-mantle:CreateInference` (resource `project/*`, condition `bedrock-mantle:Model`), plus `Get*`/`List*`. Web search is the separate `bedrock-websearch:InvokeSearch`/`InvokeFetch`. | Service authorization reference; `AmazonBedrockMantleInferenceAccess` |
| Metering signal: CloudWatch `AWS/BedrockMantle` `InputTokens`/`OutputTokens` per Project+Model. There is no cache split and no caller identity. | Mantle metrics doc |
| Audit: `CreateInference` is a CloudTrail **data event** (`AWS::BedrockMantle::Project`). It is off by default and needs a trail with an advanced event selector. Management events (ListModels, projects) are logged free. | Mantle CloudTrail doc |

## Design

### 1. Entitlement = "unlimited" (budget-check, every 5 min)
A user is **mantle-eligible** when every cap that could apply to them is unlimited:

- effective daily, weekly and monthly USD caps = 0 (user → dept per-user default → global, per `_effective_user_limits`);
- their department's total budget = 0;
- no `LIMIT#` token limit row for `USER#{email}` or `DEPT#{dept}`.

`budget-check` already loads every Cognito user with subdomain (`_load_valid_user_keys`) and knows their role names.
For each user it reconciles one inline policy, `cc-bedrock-mantle-unmetered`, on `cc-on-bedrock-local-user-{subdomain}`.
- **Eligible:** put the policy, allowing `bedrock-mantle:CreateInference`/`Get*`/`List*` on **that user's own project ARN only** (us-east-1) and `bedrock-websearch:InvokeSearch`/`InvokeFetch`.
- **Not eligible:** delete the policy.

Setting any cap revokes mantle within one run (≤ 5 min). Usage in that window is unmetered, but the user was unlimited until then.
Fail-safe: on a budget/limits read error, the run revokes mantle (never grants on partial data).

### 2. Per-user mantle project
On first eligibility, `budget-check` creates a project in us-east-1 with `POST /v1/organization/projects`, signed with SigV4 by botocore. No boto3 client exists for it.
- Name: `cc-<subdomain>`. Tags: `cc-on-bedrock:user=<email>`, `cc-on-bedrock:managed=true`.
- *Implementation call:* no extra storage. budget-check finds the user's project by its `cc-on-bedrock:user` owner tag (ListProjects returns tags), never by name alone, so a reassigned subdomain gets a new project (`ListProjects`, once per run, only when someone is eligible); sts-issuer reads the project id back from the grant policy itself, so the grant is the single source of truth.
- The project is reused on later grants and never archived automatically (ids are cheap; history stays attributable). No project is created for a user without a Local role.

Scoping IAM to the user's own project makes the header mandatory: omitting it falls to `project/default` → AccessDenied.
The `CreateProject` management event records who created it.

### 3. IAM ceiling + deny
- **Permission boundary:** allows `bedrock-mantle:CreateInference`/`Get*`/`List*` on `arn:aws:bedrock-mantle:us-east-1:{acct}:project/*` and the two `bedrock-websearch` actions. The boundary is the ceiling; the per-user inline policy narrows it to one project.
- **Per-user Bedrock allow-lists:** the six copies pinned by `test_bedrock_iam_codex_parity.py` stay mantle-free. The grant lives only in the budget-check-managed policy.
- **Deny policies:** every Bedrock deny statement (user daily, dept, local token, emergency) adds `bedrock-mantle:*` and `bedrock-websearch:*`, so a manual or emergency deny also stops mantle.
- **Dashboard role:** no mantle permissions. Project creation runs in `budget-check`, whose role gets `bedrock-mantle:CreateProject`/`ListProjects`/`GetProject`/`TagResource` on `project/*` plus `iam:PutRolePolicy`/`DeleteRolePolicy` for the new policy name.

### 4. Credentials API + client
- `/api/local/credentials` adds `mantle: {enabled, projectId, region, model, metered: false}`, read by sts-issuer from the role's grant policy.
- `cc-bedrock-local` stores it in `state.json`. After `login`, credential renewal and `setup`, it writes the managed file `~/.codex/mantle.config.toml` **only when enabled**. Codex 0.163 loads `-p <name>` from `<CODEX_HOME>/<name>.config.toml` and rejects `[profiles.<name>]` inside config.toml (verified):
  ```toml
  # managed by cc-bedrock-local — bedrock-mantle (web search). NOT counted in usage or budget;
  model_provider = "amazon-bedrock"
  model = "openai.gpt-6.1-sol"
  web_search = "live"
  [model_providers.amazon-bedrock.aws]
  profile = "cc-bedrock"
  region = "us-east-1"
  [model_providers.amazon-bedrock.http_headers]
  OpenAI-Project = "<projectId>"
  ```
  When mantle is disabled the file is removed; a user-owned file of that name (no marker) is never touched. Plain `codex` keeps the runtime default.
- **"Not metered" messages:**
  - `cc-bedrock-local setup`/`login`/`status` print `mantle (codex -p mantle): enabled — NOT counted in usage or budget; available while your cost is unlimited`.
  - The user portal Local Mode card and the in-app docs say the same.
  - The admin budget page explains that users with no cap at all also get unmetered mantle (*implementation call:* a note instead of a per-user badge).
- Model default: Terraform `codex_mantle_model_id` (default `openai.gpt-6.1-sol`). The id must exist on us-east-1 mantle; this is checked by the model-id consistency test.

### 5. Audit (CloudTrail data events, us-east-1)
- New Terraform (usage-tracking module):
  - A single-region `aws_cloudtrail` in **us-east-1** (provider alias), with an advanced event selector for `eventCategory=Data`, `resources.type=AWS::BedrockMantle::Project`, and a dedicated S3 bucket (SSE, 90-day lifecycle).
  - An EventBridge rule in us-east-1 on `eventSource=bedrock-mantle.amazonaws.com`, `eventName=CreateInference`, targeting the Seoul default bus (cross-region target + IAM role). There, a rule feeds the existing `audit-logger`.
- `audit-logger` accepts `CreateInference` from `bedrock-mantle.amazonaws.com`. It records the model from `requestParameters.model`, `client_tool` from the userAgent and `provider = mantle`. A Security page tag for these rows is a follow-up.
- The whole block is behind `enable_mantle` (default `true` per this decision). With `false`, no trail is created, boundary and deny are unchanged, and budget-check never grants.

### 6. Scope
- **In:** Local Mode (governance default) end to end; Terraform; Lambdas; dashboard API/UI text; CLI; docs (ADR-014 amendment, BASELINE §1/§3 row, architecture.md, runbook `codex-cost-budget-audit.md`, CHANGELOG, module CLAUDE.md files).
- **Follow-up (not in this PR):** EC2 DevEnv mantle profile. Instance user data would need the project id at boot plus refresh when entitlement changes; the IAM grant in budget-check would already cover `cc-on-bedrock-task-*` once added; the Security page "Codex (mantle, unmetered)" tag (rows already carry `provider = mantle`).
- **Non-goals:**
  - metering mantle per user (CloudWatch Project metrics stay visible to admins only as an aggregate);
  - mantle for Claude Code;
  - mantle in Seoul.

## Risks
- Unlimited users can spend on mantle without any cap. That is the decision, made visible by the badges and messages.
- Mantle data is processed in **us-east-1** (runtime uses global CRIS already, but mantle is explicitly US). This should be called out in the in-app docs.
- CloudTrail data-event cost: about $0.10 per 100k inference calls, plus the S3 trail bucket.
- Codex's mantle region allow-list is client-side and may change with Codex releases. The model-id test pins the default.
- Web search queries are billed by `bedrock-websearch` and are not metered here either. They fall under the same unmetered statement.

## Verification plan
- **Unit:**
  - eligibility function (all cap sources, fail-safe on read error);
  - policy document (own-project ARN only);
  - deny statements include mantle + websearch;
  - credentials API `mantle` field;
  - CLI profile add/remove + idempotence;
  - audit-logger CreateInference parsing;
  - `terraform validate` / fmt;
  - BASELINE/ADR-014 updated in the same PR.
- **Live (samples or demo account):**
  - an unlimited test user gets the policy and project, and `codex -p mantle` web search works;
  - a call without the header is AccessDenied;
  - setting a $1 cap removes the policy on the next run and mantle returns AccessDenied;
  - the data event appears in `audit-logger` rows.
