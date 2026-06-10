# Changelog

All notable changes to CC-on-Bedrock are documented in this file.

## [1.3.0] - 2026-05-28 (Local Governance Mode + CloudFront Split + Self-Healing CI)

### Architecture
- **Local Governance Mode (ADR-014)** — New deployment profile that drops EC2/ECS DevEnv and lets developers run `claude` from their own machines while keeping centralized governance. STS Issuer Lambda + Function URL issues 1h chained-AssumeRole credentials; per-user `cc-on-bedrock-local-user-{cognito_sub}` IAM role with Permission Boundary; usage tracking + token-limit-enforcer DynamoDB Stream consumer; limit-reset EventBridge crons (daily/weekly/monthly KST). Enabled via `cdk deploy --context governanceOnly=true`. Coexists with EC2 mode.
- **Dollar Budget × Normalized Token Limit Integration (ADR-015)** — Two independent enforcement axes share IAM Deny policies on the same per-user role: (a) `BudgetExceededDeny` from 5-min budget-check cron, (b) `cc-bedrock-local-token-deny` from DynamoDB Stream-driven token-limit-enforcer. Distinct policy names so each axis cleans up independently. Dashboard `/admin/budgets` PUT now mirrors `monthlyBudget` (USD) into `cc-on-bedrock-limits LIMIT#monthly.max_normalized` via `NORMALIZED_PER_USD` factor (default 66667 ≈ Sonnet output reference). Race window from ~5 min cron-only to ~1-2 s Stream path.
- **CloudFront Split (ADR-016)** — Single unified CloudFront from ADR-013 split into two distributions: Dashboard CF (Stack 05, ALB origin, `<dashboardSubdomain>.<domain>`) and DevEnv CF (Stack 04, NLB origin, `*.dev.<domain>` with viewer-request Lambda@Edge session-validator). Host-based origin router Lambda@Edge deprecated and archived. Lower edge complexity, clearer per-distribution caching policy.
- **Dashboard rolling deployment + circuit breaker (ADR-017)** — ECS service rolling update with `minHealthyPercent=50` and CloudWatch alarm rollback. Removed zero-downtime gap from the v1.2.0 `minHealthyPercent: 0` workaround.
- **DevEnv OS choice (ADR-018)** — Per-user EC2 can boot Ubuntu 24.04 ARM64 or Amazon Linux 2023 ARM64. SSM Parameter `/cc-on-bedrock/devenv/ami-id/{os}` with legacy single-key fallback.
- **Bedrock Model ID normalization (ADR-019)** — Canonical `global.anthropic.claude-{model}-{ver}` IDs across all components; weights calibration ($-proportional) so `NORMALIZED_PER_USD` holds approximately across Claude families.
- **Runtime IAM policy upsert (ADR-020)** — Pre-provisioned per-user roles patched at runtime by enforcers instead of re-deploying CloudFormation, removing the multi-minute drift between dashboard budget edit and IAM effect.
- **Wildcard Claude IAM (ADR-021)** — Per-user roles authorize `claude-*` foundation models via a single wildcard ARN pattern, eliminating per-version IAM policy churn.
- **EventBridge user pre-provisioning (ADR-022)** — `cognito-user-created` rule triggers `UserRoleProvisioner` Lambda + DLQ. New users get their Local Governance role and Permission Boundary before first STS request, removing the IAM-propagation race at first login.
- **Dept per-user budget default (ADR-023)** — Department-level `perUserMonthlyBudget` is the default budget for new members; explicit `cc-user-budgets.monthlyBudget` overrides per-user. Budget resolution priority: user explicit > dept default > global `DAILY_BUDGET` env.
- **Cognito deletion cleanup (ADR-024)** — Provisioner Lambda also deletes per-user IAM role + Permission Boundary on `cognito-user-deleted` event. Idempotent (handles already-deleted), DLQ on partial failures.

### Closed-loop CI
- **ADR-verify pipeline Phase 1+2 (PR #29)** — `.adr-verify/` toolkit with frontmatter `verification_required` + per-ADR `## Verification` blocks. 24 ADRs backfilled with frontmatter; 6 high-priority ADRs (011, 014, 021, 022, 023, 024) gained full Verification sections (Static, Runtime, Permissions checks). PR workflow `adr-verify-pr.yml` and main workflow `adr-verify-main.yml`.
- **Self-healing pipeline (PR #34)** — `main` push → ADR re-verify → if any ADR fails, open a labeled issue → `issue-auto-implement.yml` triggers Claude Code with `--permission-mode acceptEdits`, scoped allow-list, forbidden-path reset → Draft PR with `needs-triage` label. Human is the merge gate.
- **Workflow hardening (PRs #38, #39, #40)** — `adr-verify-main` uses `actions/github-script` instead of `gh` CLI for reliability inside GitHub Actions; `workflow_dispatch` `test_mode` for end-to-end smoke testing without waiting for a failing ADR. `issue-auto-implement` prefers `git diff` over the `NO_CHANGE:` stdout marker so reasoning-trace code blocks can't discard real edits.

### Budget enforcement — gap closures
- **`attach_deny_policy` covers Local roles too (PR #31)** — Previously only tried `cc-on-bedrock-task-{subdomain}`; Local-only users hit `NoSuchEntity` and silently bypassed the daily/monthly $ budget enforcement. Now resolves both EC2 + Local via the same `_local_role_index` (username-tag reverse index) that dept-deny was already using.
- **`/api/admin/budgets` PUT mirrors $ into LIMITS table (PR #31)** — Dashboard budget edits now write both `cc-user-budgets.monthlyBudget` (USD) and `cc-on-bedrock-limits[USER#{id}] LIMIT#monthly.max_normalized` (token-equivalent) in one transaction. Stream-driven enforcer reacts within ~1-2 s instead of waiting for the 5-min cron. `monthlyBudget=0` deletes the LIMIT row so dept default takes over.
- **Username ↔ sub-UUID asymmetry resolved (PR #38)** — `cc-on-bedrock-usage` PKs use Cognito *username* (`USER#atomoh`) while real IAM role names embed the Cognito *sub UUID*. New shared `cdk/lib/lambda/iam_role_lookup.py` reverse-indexes the IAM `username` tag (set by `role_factory.ensure_role`) so `token-limit-enforcer._attach_deny`, `limit-reset._detach`, and `budget-check`'s backup token-deny path all hit the deployed role instead of a phantom `cc-on-bedrock-local-user-atomoh`. Per-username one-shot rescan covers users provisioned after the warm container's cold-start scan. `iam:ListRoles` + `iam:ListRoleTags` grants added to enforcer + limit-reset Lambda roles. ADR-015 Addendum 1 + 2.

### Terraform parity (PR #28)
- **Four new modules**: `ec2-devenv`, `local-governance`, `usage-tracking`, `waf`. Root `main.tf` wiring still pending — see deployment guide warning.

### Dashboard / Docs
- **`/local` page (ADR-014)** — Self-service STS credentials button, normalized token usage gauges (daily/weekly/monthly, self + dept), `cc-bedrock-local` CLI download + paste-ready config snippet, Deny-active banner.
- **`/admin/limits` page (ADR-014)** — Normalized token limit CRUD per user/dept, force-reset button (`/api/admin/limits/reset`) that detaches `cc-bedrock-local-token-deny` + clears `DENY#active`.
- **`/admin/budgets` revamp (ADR-023, PR #31)** — Adds `perUserMonthlyBudget` field on dept rows; user `monthlyBudget=0` means inherit from dept.
- **Comprehensive docs refresh (PRs #32, #43)** — `webpage/docs/` rewritten as Next.js 14 + Tailwind static export. Added Local Governance Mode guide (`local-mode.md`), STS 1h truth (was previously documented as 8h), ADR-016 split model in architecture + deployment docs, VPC Endpoints scope clarification (EC2 only), `/api/install/cli` as canonical download channel.
- **`/model` "Default" routes to Sonnet 4.6 (PR #30)** — Drop `ANTHROPIC_MODEL` pin and set `ANTHROPIC_DEFAULT_SONNET_MODEL` so the Claude Code picker shows "Default" instead of forcing the "Custom" slot. Real Opus 4.6 restored to the "Opus" slot. `cc-bedrock-local` wrapper, install snippet, EC2 UserData, devenv `entrypoint.sh` all aligned.

### Fixed
- **Non-admin home-dashboard instance status (PR #27)** — Self-service users now see their own instance card without admin-only API calls; CLI auto-update on boot via `cc-cli-update.service`.
- **MDX image-alt escape (PR #35)** — Parens in alt text were truncating the rendered image in MDX; escaped consistently.

### Documentation
- **ADR-014 through ADR-024** — 11 new Architecture Decision Records covering Local Governance Mode and the ecosystem around it. ADR-013 marked superseded by ADR-016 (auth model still applies; distribution layout changed).
- **`docs/runbooks/`** — New per-mode runbooks for credential issuance, limit reset, Local user offboarding.
- **CLAUDE.md sync** — Root + `cdk/`, `tools/`, `shared/nextjs-app/`, `docker/`, `terraform/` modules all updated for new pages, Lambdas, modules.

### Operations notes
- **PR #38 + #31 require `cdk deploy CcOnBedrock-LocalGovernance CcOnBedrock-UsageTracking` after merge** — the dashboard's auto-deploy workflow covers `shared/nextjs-app/**` only; CDK Lambda code + IAM policy changes do not auto-deploy yet. Follow-up issue tracks adding a `deploy-cdk.yml`.
- **Existing rows in `cc-user-budgets`** are not auto-mirrored into `cc-on-bedrock-limits`; admins must re-PUT each affected row once after upgrading to v1.3.0 (or a small backfill script can replay the writes).

## [1.2.0] - 2026-04-17 (EC2-per-user + Unified Auth)

### Architecture
- **EC2-per-user DevEnv (ADR-004)** — Replaced ECS container-based devenv with dedicated EC2 instances (ARM64 t4g.medium~large). Per-user IAM Instance Profile, EBS root volume, ~30s cold start
- **EC2 Hibernation (ADR-010)** — ~5s resume by saving RAM to encrypted EBS. Feature flag `HIBERNATE_ENABLED`, graceful fallback on failure, 60-day rotation limit
- **Unified CloudFront (ADR-013)** — Merged 2 CloudFront distributions into 1. Lambda@Edge session-validator (NextAuth JWE) + origin-router (Host-based NLB/ALB routing). Single sign-on across Dashboard + DevEnv
- **Multi-port DevEnv routing (ADR-009)** — `?folder=` → code-server :8080, `/api/` → :8000, `/` → :3000 via Nginx named locations
- **MCP Gateway (ADR-007)** — 2-tier AgentCore Gateway: common gateway (8 tools) + per-department gateways. DynamoDB Streams → Lambda auto-sync
- **Bedrock IAM Cost Allocation (ADR-011)** — CUR 2.0 export + Cost Explorer tags for per-user/dept cost attribution

### Dashboard
- **Direct login form** — No Cognito Hosted UI redirect; credential-based login with custom form
- **Department management** — Cognito `custom:department` attribute, dept dashboard with budget/usage views
- **Approval workflow** — EBS resize, tier change, DLP change via `cc-approval-requests` DynamoDB
- **DLP management** — DNS Firewall domain allow/block admin UI
- **Slack integration** — Slash commands + event subscriptions for notifications
- **AI Resource Review** — Bedrock-powered smart analysis before EBS resize requests
- **Bedrock monitoring fix** — Switched from CloudWatch AWS/Bedrock (account-wide) to DynamoDB `cc-on-bedrock-usage` (project-filtered, 3-layer IAM role prefix filtering)
- **Token dashboard** — Admin token usage analytics
- **Built-in docs** — 6 documentation pages (getting-started, user-guide, admin-guide, architecture, security, FAQ)

### Infrastructure (CDK)
- **Stack 07 (EC2 DevEnv)** — Launch Template, per-user Instance Profile (`cc-on-bedrock-task-{subdomain}`), DLP Security Groups (open/restricted/locked)
- **Stack 05 updated** — Unified CloudFront with Lambda@Edge (session-validator, origin-router), SSM-based config for Lambda@Edge
- **Stack 04 simplified** — Removed CloudFront + Lambda@Edge (moved to Stack 05), NLB + Nginx only
- **Stack 02 cleaned** — Removed DevEnv Cognito OAuth client + cookie secret (superseded by ADR-013)
- **Bedrock invocation logging** — `textDataDeliveryEnabled: false` cuts CloudWatch Logs cost ~99%
- **IAM managed policies** — Split inline policy to avoid 10KB limit

### Security
- **Permission Boundary** — Per-user `cc-on-bedrock-task-boundary` with InvokeGateway scoping
- **NextAuth cookie domain** — `.atomai.click` for SSO across dashboard + devenv subdomains
- **Budget enforcement** — 5-min Lambda checks, IAM Deny Policy auto-attach on overspend

### Fixed
- **code-server YAML password** — `!` prefix caused YAML tag parse error; fixed by quoting passwords
- **ECS deployment downtime** — `minHealthyPercent: 0` causes 503 during deploy (documented)
- **Bedrock monitoring accuracy** — CloudWatch showed account-wide usage; now uses DynamoDB project-only data
- **IAM inline policy 10KB limit** — Split into multiple managed policies
- **EC2 instance tag unification** — Removed `cc:` prefix duplicates, keep IAM role tags

### Documentation
- **ADR-004 through ADR-013** — 10 new Architecture Decision Records
- **CLAUDE.md sync** — Root + nextjs module updated with all new pages, API routes, components, libs
- **Architecture diagram** — Mermaid diagrams updated for unified CF, EC2 DevEnv lifecycle, MCP Gateway
- **Deployment scripts** — 8 step-by-step deployment scripts (`00-check-prerequisites` through `08-verify-deployment`)

### Removed
- **ECS DevEnv containers** — Replaced by EC2-per-user instances (ADR-004)
- **DevEnv CloudFront distribution** — Merged into unified CF (ADR-013)
- **Cognito DevEnv OAuth client** — Replaced by NextAuth cookie SSO (ADR-013)
- **Lambda@Edge devenv-auth-edge** — Replaced by session-validator (ADR-013)
- **CloudWatch Bedrock metrics** — Replaced by DynamoDB-based metrics (project-only)

---

## [1.1.0] - 2026-03-30 (Enterprise Edition)

### Architecture
- **NLB → Nginx → ECS Routing** — Replaced ALB per-user Target Group/Rule (100 rule limit) with NLB + Nginx reverse proxy (unlimited users)
- **DynamoDB Routing Table** — `cc-routing-table` with Lambda → S3 → Nginx 5s hot-reload pipeline
- **IMDS Block** — `ECS_AWSVPC_BLOCK_IMDS=true` forces per-user Task Role credentials (not Instance Role)
- **EFS Access Point** — Per-user EFS isolation via dynamic Access Point creation
- **SSM Parameter Store** — Cognito Client ID/Secret stored securely (no hardcoding in UserData)

### Dashboard UX
- **Polling flicker fix** — 8 pages: initial-load-only guard, no UI unmount on background refresh
- **Department dashboard filtering** — Pill selector, DeptCard grid, 2-mode view (overview/detail), `/api/dept/list` endpoint
- **Container storageType display** — EBS/EFS badges in dropdown, config preview, containers table
- **Health-aware URL** — URL shown only when `healthStatus=HEALTHY`, "Starting..." otherwise
- **Fast polling** — 5s during container startup, 30s when healthy
- **Stop UI refresh** — Immediate `fetchData()` after container stop
- **Sidebar active state** — Fixed nested route highlighting (`/admin` vs `/admin/containers`)
- **Per-user storageType** — Added to UserSession JWT, self-service container start, EBS resize API (per-user check replaces global env)
- **Users table** — Storage column sortable + filterable (EBS/EFS)

### Security
- **Per-user Task Role enforcement** — IMDS blocked, containers use `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
- **Permission Boundary** — Added KMS Decrypt + deploy bucket access for Nginx S3 config
- **CloudFront wildcard cert** — `*.dev.atomai.click` ACM certificate in us-east-1
- **NLB Security Group** — CloudFront prefix list only on port 80
- **Nginx SG → DevEnv SG** — Port 8080 ingress for Nginx proxy
- **Cognito IAM** — Added `AdminSetUserPassword` to dashboard role

### Container Management
- **code-server password sync** — `CODESERVER_PASSWORD` env var (no Secrets Manager dependency at startup)
- **entrypoint.sh stability** — `chown || true`, skip symlinks in isolated storage, workspace at `/workspace`
- **Idle timeout fix** — `warm-stop.py`: no metrics = NOT idle (fail safe), 10min grace period
- **Docker image** — Nginx (`cc-on-bedrock/nginx:latest`) + devenv rebuild with all fixes

### Infrastructure (CDK)
- **ALB removed** — DevEnv ALB completely removed from `04-ecs-devenv-stack.ts`
- **NLB + Nginx ECS Service** — internet-facing NLB, 2 Nginx tasks (HA), health check on `/health`
- **Cross-stack exports resolved** — `userPoolClient`, `devenvAlbListenerArn`, `cloudfrontSecret` (3 fixes)
- **CloudFront origin** — ALB → NLB with `X-Custom-Secret` header
- **devEnvCertArn** — Added to `cdk.context.json` to prevent alias reset on deploy
- **Lambda** — `nginx-config-gen.py` field name fix, `DEV_DOMAIN` env, deploy bucket permissions

### Data
- 38 Cognito users configured
- 20 EBS users, 18 EFS users

### Validation
- `scripts/validate-deployment.sh` — 20 automated checks (infra, IMDS, Task Role, Nginx, CloudFront, E2E, auth)
- Playwright E2E tests (login → container start → URL access)

### Removed
- DevEnv ALB (`CcOnBe-Deven-F5qj2knppzUd`) — replaced by NLB
- ALB registration functions (preserved as `_legacy`)
- Unused Cognito User Pool (`ap-northeast-2_IRnckXMMl`)
- Unused Cognito App Client (`4bbepi34tcjni0ati3etfsb5f1`)

---

## [1.0.0] - 2026-03-25

### Architecture
- **Bedrock Direct Mode** — Removed LiteLLM proxy entirely; Claude Code calls Bedrock directly via ECS Task Role + VPC Endpoint
- **5 CDK Stacks** — Network, Security, Usage Tracking, ECS DevEnv, Dashboard
- **Hybrid AI Assistant** — Dashboard uses Converse API (real-time streaming), Slack/external uses AgentCore Runtime + Gateway
- **Per-user IAM Roles** — Individual `cc-on-bedrock-task-{subdomain}` roles with dynamic Deny Policy for budget control
- **Serverless Usage Tracking** — CloudTrail → EventBridge → Lambda → DynamoDB (~$5/month, replaced $370/month LiteLLM stack)

### AgentCore Integration
- AgentCore Runtime (`cconbedrock_assistant_v2`, PUBLIC mode, Strands Agent)
- AgentCore Gateway (`cconbedrock-gateway`, MCP protocol, 3 Lambda targets)
- AgentCore Memory (per-user session isolation, conversation history)
- 8 MCP Tools: get_container_status, get_efs_info, get_container_metrics, get_spend_summary, get_budget_status, get_system_health, get_user_usage, get_department_usage
- SigV4-signed MCP transport (streamable_http_sigv4.py)

### Dashboard (Next.js)
- 7 pages: Home, AI Assistant, Analytics, Monitoring, Security, Users, Containers
- Users/Containers tables: sorting (6 columns) + filtering (OS, Tier, Security, Status dropdowns)
- Containers: Config column with OS + Tier badge + CPU/Memory specs, EFS storage panel
- AI Assistant: Bedrock Converse API + Tool Use, SSE streaming, copy button, AgentCore Memory history
- Container duplicate prevention (409 Conflict)
- ALB stale target auto-cleanup on container restart
- EFS total/per-user storage display

### Security
- 7-layer defense: CloudFront → ALB (Prefix List + X-Custom-Secret) → Cognito OAuth 2.0 → Security Groups (3-tier DLP) → VPC Endpoints → DNS Firewall → IAM/DLP
- Cognito Hosted UI with dark theme CSS, custom invite email
- NextAuth cookies (secure:false for CloudFront→ALB HTTP), middleware with custom cookieName
- Cognito ExplicitAuthFlows: SRP + PASSWORD + REFRESH

### Container Management
- 6 Task Definitions (Ubuntu/AL2023 × Light/Standard/Power)
- Per-user EFS directory isolation (`/users/{subdomain}/`)
- ECS Exec enabled (enableExecuteCommand: true)
- Per-user IAM Task Role with Bedrock permissions
- ALB Host-based routing with auto target group management

### Budget Control
- CloudTrail → EventBridge → Lambda (usage-tracker) → DynamoDB
- Lambda (budget-check) every 5 minutes
- 80% warning → SNS alert
- 100% exceeded → IAM Deny Policy on user's Task Role + Cognito flag + SNS alert
- Next-day auto-release of Deny Policy
- SNS Topic for budget alerts

### Infrastructure as Code
- CDK (TypeScript): 5 active stacks, CDK synth verified
- Terraform (HCL): 4 modules (LiteLLM removed)
- CloudFormation (YAML): 4 templates (CLAUDE_CODE_USE_BEDROCK=1 in all 6 task defs)
- All three IaC tools synchronized with Bedrock Direct architecture

### Docker
- devenv-ubuntu:ubuntu-latest (Ubuntu 24.04, ARM64)
- devenv-al2023:al2023-latest (Amazon Linux 2023, ARM64)
- agent:latest (Strands Agent + MCP Gateway client)
- entrypoint.sh: per-user EFS dirs, Kiro/Claude config, DLP policy, idle-monitor

### Documentation
- README: bilingual (English/Korean) with architecture diagram and 8 screenshots
- 4 output docs with full English translation: component-roles, user-auth-container-security, ai-assistant-architecture, full-architecture-detail
- All CLAUDE.md files synced with current architecture
- docs/architecture.md: full Mermaid diagram rewrite

### Removed
- LiteLLM Proxy (EC2 x2, RDS PostgreSQL, Valkey, Internal ALB) — $370/month savings
- Amazon Polly TTS — removed from Dashboard and IAM
- `ccbaedrock-dashboard` typo domain from CloudFront
- Stale DynamoDB records (old user naming convention)

### Fixed
- Container start error: added `ecs:TagResource` to Dashboard EC2 IAM role
- ALB 504 Gateway Timeout: stale target auto-cleanup before new IP registration
- Cognito OAuth login: fixed NEXTAUTH_URL typo, added ExplicitAuthFlows
- NextAuth State cookie missing: custom cookie config (secure:false) + middleware cookieName
- Container CPU/Memory display: read from container definition level (EC2 mode task.cpu is null)
- InvokeAgentRuntime StreamingBody: use `transformToString()` for SDK v3
- SSE timeout: keep-alive heartbeat every 5s during Runtime processing
- Lambda KMS permission: added kms:Decrypt for DynamoDB table encryption
- EFS Permission Denied: ownership mismatch (ubuntu→coder UID change)
