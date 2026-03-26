# Changelog

All notable changes to CC-on-Bedrock are documented in this file.

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
