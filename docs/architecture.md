# CC-on-Bedrock — Architecture (SSOT)

> **SINGLE SOURCE OF TRUTH for the CURRENT architecture. Read this FIRST.**
> ADRs in `docs/decisions/` are the *decision log* (why); the decision baseline is
> `docs/decisions/BASELINE.md`. Anything under `docs/decisions/archive/` or `docs/history/`
> is **historical / superseded — NOT current**.
> Last reconciled: 2026-10-24 (Terraform-only; dashboard real-app deploy on EC2 ASG; lightweight OTEL session/git telemetry; Codex on Bedrock, ADR-014; budget increase approvals + role groups, ADR-008 amendment 2026-10-24).

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
  EC2 -. lightweight session/git OTEL .-> OT[OTEL Collector]
  BR -. invocation logs .-> AGG[Inference Profile + Invocation Log → DynamoDB]
```

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
   governance (ADR-014). Codex uses only the `amazon-bedrock-runtime` provider (bedrock-runtime
   Responses API, `global.openai.*` profiles; never bedrock-mantle) with the same per-user role
   credentials (IMDS on EC2, `credential_process` in Local Mode — `cc-bedrock-local codex` / `ccx`).
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
   model (ADR-002):** ephemeral OS root EBS (`DeleteOnTermination=true`, replaceable via new AMI) +
   **persistent data EBS** for `/home/coder` (GP3, `DeleteOnTermination=false`, subdomain-tagged,
   reattached across rebuild/OS-switch). Idle instances Stop/Hibernate and resume with state intact.
7. **Self-service IAM.** UI requests for extra IAM permissions require **admin approval**, bounded by
   a permission boundary authored in Terraform (boundary X = AllowInAccount; the DenyEscalation
   63-action floor's full TF port is a **follow-up** tracked by ADR-007 — not yet complete).
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

두 에디션 모두에서 동작한다. IAM 확장·컨테이너·티어·DLP 승인은 `devenv` 전용이며 admin만 처리한다.

| | `governance` (기본) | `devenv` |
|---|---|---|
| 비용 현황 · 부서 예산 · 사용자 한도 · 차단 목록 | O | O |
| 예산 증액 요청 · 승인 | O | O |
| 부서장의 부서원 상시 한도 | O | O |
| IAM 확장 / 컨테이너 / 티어 / DLP 승인 | X | O (admin) |
| ccdash 링크 (`ccdash_url`) | 선택 | 선택 |

```text
사용자 (/local, LocalSetup, devEnv 포털)
  └─ POST /api/user/budget-increase {period, requestedAmount, reason}
       → 승인 테이블 REQUEST#{id} (pending) + 잠금 PENDING#{email}#{period}#{UTC key}
승인자 (/admin/approvals — admin, 또는 middleware APPROVER_PATHS로 dept-manager)
  └─ POST /api/admin/approval-requests {requestId, action, amount?, reason?}
       → requireFreshRole + Cognito 부서 재조회 → decideBudgetAction
       → TransactWriteItems: 요청 approved · 잠금 삭제
                             · cc-user-budgets  ADD grant#{period}#{key} (요청 기간→월 연쇄, 무제한 기간 제외)
                             · cc-department-budgets ADD grant#monthly#{key} (금액 1회; manager 승인은 낙관적 조건)
       → releaseTokenAxis: LIMIT#monthly grant_bucket/grant_normalized (KST 월), 모든 토큰 cap 미만일 때만 DENY#active 해제
budget-check (5분, UTC)
  └─ cap(period) = 기존 해석(user > dept 인당 > 전역) + 현재 창 grant (cap > 0일 때만)
       → USD deny 해제, activeGrant* 기록 → 대시보드 "기본 + 증액" 표시
```

- **일회성**: grant는 승인 시점의 UTC 창(오늘 / 이번 ISO 주 / 이번 달)에만 맞는 키로 저장되므로 다음 창에서는 자동으로 원래 한도로 돌아간다. 영구 한도는 바뀌지 않는다.
- **승인 권한**: 자기 승인 금지(모든 타입). admin은 전부. dept-manager는 자기 부서 plain user의 `budget_increase`만, 부서 월 총액(budget-check이 기록한 부서 지출 + 이번 달 부서 grant + 금액) 안에서만. 지난 창의 pending 요청은 `expired`.
- **부서장 상시 한도**: `PUT /api/dept/user-budgets` — 같은 부서 plain user의 일·주·월 한도(0 = 상속, 개인 월 ≤ 부서 총액). 부서 총액·인당 기본값은 admin 전용(`PUT /api/admin/budgets`). 두 경로 모두 행 갱신과 `limit_change` 감사를 한 트랜잭션으로 기록한다.
- **역할**: Cognito 그룹 `admin` / `dept-manager` / `user` 중 정확히 하나. admin이 관리자 사용자 페이지에서 지정하면 즉시 Cognito에 반영되고 대상 세션은 global sign-out된다. 특권 쓰기는 `AdminListGroupsForUser`로 현재 그룹을 재확인한다(세션 8h).
- **ccdash**: 별도 제품. `ccdash_url`이 있으면 사이드바 링크와 수집기 설치 안내(`{ccdash_url}/collector`, `user.email` = Cognito 이메일)만 보여준다. cc는 텔레메트리 설정을 쓰지 않는다.
- 알려진 제약은 ADR-008 "알려진 제약 (2026-10-24)"에 모아 둔다.

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
- Never grant `bedrock-mantle:*`; Codex stays on bedrock-runtime (ADR-014).

## Where decisions live
- **Current truth:** this file + `docs/decisions/BASELINE.md`.
- **Why (log):** `docs/decisions/ADR-*.md`; superseded → `docs/decisions/archive/` (not current).
