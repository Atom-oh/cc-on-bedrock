# CC-on-Bedrock — Architecture (SSOT)

> **SINGLE SOURCE OF TRUTH for the CURRENT architecture. Read this FIRST.**
> ADRs in `docs/decisions/` are the *decision log* (why); the decision baseline is
> `docs/decisions/BASELINE.md`. Anything under `docs/decisions/archive/` or `docs/history/`
> is **historical / superseded — NOT current**.
> Last reconciled: 2026-10-26 (Terraform-only; governance/devenv profiles; BYO VPC; dashboard on EC2 ASG; native Claude Code OTEL; Codex on Bedrock; budget increase approvals + role groups, ADR-008 amendment 2026-10-24).

## What this is
멀티유저 Claude Code 개발환경 플랫폼 on AWS Bedrock. 사용자는 per-user EC2 DevEnv(브라우저 IDE)
또는 로컬 PC에서 Bedrock을 호출하고, 사용량·예산·IAM 권한이 중앙에서 거버넌스된다.

## Access paths

The self-service portal distinguishes unavailable status from an absent
environment. Failed refreshes retain the last verified state and expose retry or
sign-in recovery. Start/stop controls require verified status; `STOPPING` remains
visible until the status API confirms completion. Provisioning progress requires
a terminal event, and closing its view does not cancel the underlying start.
Custom-route version conflicts preserve local edits until the user explicitly
reloads the server configuration.

```mermaid
graph LR
  subgraph EC2 Mode
    U1[User Browser] --> CFd[CloudFront · devenv] -->|VPC origin| NLB[internal NLB] --> NG[nginx · ECS Fargate] --> EC2[per-user EC2 DevEnv]
    EC2 --> BR[(Amazon Bedrock)]
  end
  subgraph Dashboard
    U2[User Browser] --> CFa[CloudFront · dashboard] -->|VPC origin| ALB[internal ALB] --> DASH[Dashboard · EC2 ASG + Docker]
  end
  subgraph Local Mode
    L[cc-bedrock-local CLI] --> CG[Cognito public client] --> API[Dashboard /api/local/credentials] --> STS[STS issuer]
    STS -. 1h creds .-> L
    L --> BR
  end
  EC2 -. native Claude Code OTEL .-> OT[OTEL Collector]
  OT -. scrubbed metrics/events .-> S3[S3 → productivity rollup Lambda → DynamoDB]
  BR -. invocation logs .-> AGG[Usage tracker Lambda → DynamoDB]
  AGG -. counters/budgets .-> DENY[Token enforcer + scheduled budget checks → IAM deny]
```

![Current access paths and governance flows](../img/cconbedrock_arch.png)

> **Deployment profiles:** `deployment_mode = "governance"` (default) deploys only the Dashboard and Local Mode paths. The EC2 Mode path, the OTEL collector and the EC2 idle/hibernate schedules exist only with `deployment_mode = "devenv"`. With the mode unset, `terraform plan` fails if DevEnv security groups already exist, so an older tfvars cannot silently destroy DevEnvs.
> 2 CloudFront distributions (ADR-003): devenv(→NLB→nginx, devenv profile only) and dashboard(→ALB→EC2 ASG), 분리.
> 두 LB 모두 **internal**(private subnet)이며 CloudFront **VPC origin**으로만 도달한다. LB SG ingress는 `CloudFront-VPCOrigins-Service-SG`만 허용하고, nginx는 NLB SG만 허용한다. 공인 IP·internet-facing LB 없음.
> **Network (BYO VPC):** 스택은 VPC·서브넷·NAT·IGW·게이트웨이 엔드포인트를 만들지 않는다. `vpc_id`와 subnet ID 목록을 tfvars로 받고(ADR-015), VPC에 없는 interface endpoint만 `interface_endpoint_services`로 추가한다. Route 53 공용 zone(`domain_name`)은 다른 프로젝트와 공유하므로 data source로 조회하고 레코드만 추가한다.
> Dashboard runs the real Next.js standalone container from Terraform-managed ECR. `dashboard_image_tag`
> is injected into the launch template and pinned to the ASG for deterministic instance refresh.
> `NEXTAUTH_SECRET` is fetched from SSM at boot, DevEnv edge auth strips NextAuth cookies before
> forwarding to per-user origins, and dashboard ECR is bootstrapped before image push on fresh deploys.

## Canonical decisions (the 9 pillars)

1. **Tools on Bedrock.** Claude Code and the **OpenAI Codex CLI** both run on Bedrock under the same
   governance (ADR-014). Codex uses the `amazon-bedrock-runtime` provider (bedrock-runtime
   Responses API, `global.openai.*` profiles) with the same per-user role
   credentials (IMDS on EC2, `credential_process` in Local Mode — plain `codex` after `cc-bedrock-local setup`).
   Local Mode users with no cost cap also get `codex -p mantle` (bedrock-mantle in us-east-1, web search):
   granted per user by `budget-check`, NOT metered, audited by a us-east-1 CloudTrail data-event trail; a
   display-only cost estimate comes from `AWS/BedrockMantle` metrics (`MANTLE#` rows, may differ from the bill) (ADR-014 §9).
   DevEnv ships governed defaults in `/etc/codex/config.toml` (system layer). Kiro is installed by
   default but uses IAM Identity Center licensing — **not** part of Cognito/Bedrock usage governance.
2. **Two access paths.** EC2 Mode (CloudFront→NLB→nginx ECS→EC2) + Local Mode (`cc-bedrock-local`
   → Cognito public client → Dashboard `/api/local/credentials` → STS issuer; STS returns 1h creds,
   the CLI calls Bedrock). Terraform `deployment_mode` selects the profile: `governance` (default)
   deploys the dashboard, governance layer and local installer without EC2 Mode; `devenv` adds
   EC2 Mode (ADR-006 amendment 2026-10-23).
3. **Code-activity OTEL (native).** EC2 DevEnv enables native Claude Code OpenTelemetry
   (`claude_code.*` metrics + `tool_result`/`tool_decision` events). The collector exports
   both signals to S3 (logs DLP-scrubbed to skill/agent/tool counts, no content); a rollup
   Lambda aggregates per-user (`enduser.id` email) daily KPIs into DynamoDB
   (`PROD#`/`SKILL#`/`AGENT#`/`TOOL#`/`ACTIVE#`). Bedrock token/cost stays authoritative in
   the 005 usage pipeline. (ADR-009; P1 rewrite 2026-06-26 — supersedes the custom emitter.)
   Codex productivity telemetry is not rolled up yet (follow-up); Codex cost/tokens are fully
   covered by pillar 4.
4. **Usage metering.** Bedrock **Application Inference Profiles** + **Invocation Logs** → **DynamoDB**
   (not CloudWatch AWS/Bedrock account-wide metrics). Codex Responses calls land in the same
   invocation log (`operation = "Responses"`) and are attributed by the per-user role identity
   (the Responses API rejects application inference profiles). Rows carry `tool`
   (`claude-code`|`codex`|`other`); cost uses explicit per-model rates incl. cache read/write
   (ADR-014). Audit: CloudTrail management events → `audit-logger` → `cc-prompt-audit` with
   `client_tool` from the userAgent.
5. **Shared credential model.** EC2 and Local attribute usage through the **same Application Inference
   Profile**; they do **not** share one literal IAM role (share policy shape, permission boundary,
   tags, inference-profile attribution). Exception: Codex (ADR-014) cannot use application
   inference profiles (the Responses API rejects them), so Codex usage is attributed by the
   per-user role identity in the invocation log.
6. **DevEnv compute & storage.** Per-user EC2; OS = **Ubuntu** or **Amazon Linux 2023**. **2-volume
   model (ADR-002):** replaceable OS root EBS +
   **persistent data EBS** for `/home/coder` (GP3, `DeleteOnTermination=false`, subdomain-tagged,
   reattached across rebuild/OS-switch). Idle instances Stop/Hibernate and resume with state intact.
   **Implementation discrepancy:** ADR-002 specifies `DeleteOnTermination=true` for the OS root,
   but `ec2-clients.ts` and the Terraform launch template currently set it to `false`.
   Recovery must inventory both retained volumes; this documentation sync does not change
   deletion behavior. Persistent user data must remain protected.
7. **Self-service IAM.** UI requests for extra IAM permissions require **admin approval**, bounded by
   a permission boundary authored in Terraform (boundary X = account-scoped allowance,
   operational baseline and a 63-pattern `DenyEscalation` floor). The source contains all
   representative canonical floor entries checked by `check-policyset-boundary.py`;
   Terraform plan/show validation against the request allowlist remains a follow-up
   (ADR-007). This source check does not prove deployed-policy parity.
8. **Budget enforcement.** Per-department and per-user budgets/limits ($ + normalized token);
   **EventBridge** drives IAM deny-policy updates. Per-user USD budgets are three independent
   caps — daily / weekly / monthly (UTC windows; token limits use KST) — and any one exceeded
   blocks (ADR-008 amendment 2026-10-18). Claude Code and Codex spend count against the
   same budgets (no per-tool budget); the deny covers the Responses API.
   Blocked users request a **one-time increase**; admin or the department's dept-manager
   approves it for the current window only (see "Budget increase & roles" below,
   ADR-008 amendment 2026-10-24).
9. **Path/port routing.** code-server reached by path (`?folder=`), stays on port **8080** (reserved);
   extra user ports mapped path→port via nginx. Custom ports must not use 8080/well-known.
   The dashboard does **not** directly probe devenv:8080 (the devenv SG admits only the nginx SG, so a
   direct probe always times out); portal `healthStatus` is derived from EC2 lifecycle —
   `running` + non-blank `privateIp` ⇒ HEALTHY, else UNKNOWN (ADR-012, optimistic trade-off).

## Budget increase & roles (ADR-008 amendment 2026-10-24)

Works in both editions. IAM extension, container, tier and DLP approvals are `devenv`-only and handled by admins only.

| | `governance` (default) | `devenv` |
|---|---|---|
| Cost overview · department budgets · user caps · blocked list | O | O |
| Budget increase request · approval | O | O |
| Dept-manager standing limits for members | O | O |
| IAM extension / container / tier / DLP approvals | X | O (admin) |
| ccdash link (`ccdash_url`) | optional | optional |

```text
User (/local, LocalSetup, devEnv portal)
  └─ POST /api/user/budget-increase {period, requestedAmount, reason}
       → approval table REQUEST#{id} (pending) + lock PENDING#{email}#{period}#{UTC key}
Approver (/admin/approvals — admin, or a dept-manager via middleware APPROVER_PATHS)
  └─ POST /api/admin/approval-requests {requestId, action, amount?, reason?}
       → requireFreshRole + fresh Cognito department → decideBudgetAction
       → TransactWriteItems: request approved · lock deleted
                             · cc-user-budgets  ADD grant#{period}#{key} (requested period → monthly cascade, uncapped periods skipped)
                             · cc-department-budgets ADD grant#monthly#{key} (amount once; manager approvals carry an optimistic condition)
       → releaseTokenAxis: LIMIT#monthly grant_bucket/grant_normalized (KST month); DENY#active released only when every token cap is under
budget-check (5 min, UTC)
  └─ cap(period) = standing resolution (user > dept per-user > global) + current-window grant (only when cap > 0)
       → USD deny released, activeGrant* written → dashboard shows "base + increase"
```

- **One-time**: a grant is stored under the key of the UTC window at approval time (today / this ISO week / this month), so the next window automatically falls back to the standing cap. Standing caps never change.
- **Approval authority**: no self-approval (all types). Admins approve anything. A dept-manager approves only `budget_increase` from plain users of their own department, and only within the department monthly total (department spend recorded by budget-check + this month's department grants + amount). Pending requests from a past window are `expired`.
- **Dept-manager standing limits**: `PUT /api/dept/user-budgets` — daily/weekly/monthly caps for plain users of the same department (0 = inherit, personal monthly ≤ department total). Department totals and per-user defaults are admin-only (`PUT /api/admin/budgets`). Both routes record the row update and a `limit_change` audit in one transaction.
- **Roles**: exactly one Cognito group of `admin` / `dept-manager` / `user`. When an admin assigns it on the admin users page it is written to Cognito immediately and the target is globally signed out. Privileged writes re-check the current group with `AdminListGroupsForUser` (sessions last 8h).
- **Shared user pool (optional, ADR-016)**: with `shared_user_pool_name` set, cc runs on another stack's Cognito pool. The groups are `cc-admin` / `cc-dept-manager` / `cc-user` (`COGNITO_GROUP_PREFIX=cc-`), and a user in none of them gets no session and no `/api/local/credentials`. A department flagged `unlimitedPerUser` exempts its members from department and global per-user defaults (ADR-008 amendment 2026-10-29).
- **ccdash**: a separate product. With `ccdash_url` set, the dashboard shows only a sidebar link and collector setup guidance (`{ccdash_url}/collector`, `user.email` = Cognito email). cc writes no telemetry settings.
- Known limitations are collected in ADR-008 "Known limitations (2026-10-24)".

## IaC
- **Terraform is the only IaC.** CDK/CloudFormation removed (ADR-001). Lambda handlers in `lambda/`
  (Terraform packages them). Policies incl. permission boundary authored in Terraform (ADR-007).

## Key paths
```text
terraform/          Terraform root and modules (canonical IaC)
lambda/             Lambda source
shared/nextjs-app/  Dashboard (Next.js)
tools/              cc-bedrock-local.sh, cc-otel-code-metrics.sh
docker/nginx/       Shared nginx router image
docs/decisions/     BASELINE.md + active ADRs · archive/ = historical
```

## Hard rules (invariants)
- No new CDK/CloudFormation deployment paths. Lambda source stays in `lambda/`.
- Do not use one literal IAM role for both EC2 and Local mode.
- Do not extend chained STS credentials beyond one hour — use `credential_process` renewal.
- DevEnv data lives on the persistent data EBS, not the OS root (a Terminate must not destroy it).
- Keep port 8080 reserved for code-server.
- Keep Kiro out of Cognito and Bedrock token-limit enforcement.
- Grant `bedrock-mantle:*` only through budget-check's per-user unmetered policy (unlimited-cost users, own project); Codex defaults to bedrock-runtime (ADR-014 §9).

## Where decisions live
- **Current truth:** this file + `docs/decisions/BASELINE.md`.
- **Why (log):** `docs/decisions/ADR-*.md`; superseded → `docs/decisions/archive/` (not current).
