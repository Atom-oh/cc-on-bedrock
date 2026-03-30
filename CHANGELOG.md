# Changelog

All notable changes to CC-on-Bedrock are documented in this file.

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
