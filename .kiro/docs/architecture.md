# CC-on-Bedrock Architecture

## Key Design Principles
- **Bedrock Direct Mode** — Claude Code가 ECS Task Role로 Bedrock 직접 호출 (프록시 없음)
- **Per-user IAM Roles** — 동적 IAM Deny Policy로 개별 예산 제어
- **Hybrid AI** — Dashboard: Converse API (빠른 스트리밍), Slack: AgentCore Runtime (공유)
- **7-Layer Security** — CloudFront → ALB → Cognito → SG → VPC Endpoints → DNS Firewall → IAM/DLP
- **Serverless Tracking** — CloudTrail → EventBridge → Lambda → DynamoDB (~$5/month)

## Container Architecture
Each user gets:
- **1 ECS Task** — Isolated container (code-server + Claude Code + Kiro)
- **1 ENI** — Unique Private IP (awsvpc network mode)
- **1 IAM Role** — Per-user (`cc-on-bedrock-task-{subdomain}`) for budget control
- **1 ALB Target Group** — Host-based routing (`{subdomain}.dev.whchoi.net`)
- **1 EFS Directory** — Per-user isolation (`/users/{subdomain}/`)

## Budget Control Flow
```
ECS Task (Claude Code) → Bedrock API call
  → CloudTrail (auto-logged)
  → EventBridge Rule (match bedrock:InvokeModel)
  → Lambda: usage-tracker → DynamoDB (per-user cost)

Every 5 min: Lambda: budget-check
  → DynamoDB Scan (today's cost per user)
  → 80%: SNS warning alert
  → 100%: IAM Deny Policy on user's Task Role + Cognito flag
  → Next day: auto-release Deny Policy
```

## Security — 7 Layers
| Layer | Component | Protection |
|-------|-----------|------------|
| L1 | CloudFront | HTTPS (TLS 1.2+), AWS Shield DDoS |
| L2 | ALB | CloudFront Prefix List + X-Custom-Secret header |
| L3 | Cognito | OAuth 2.0, admin/user group-based access |
| L4 | Security Groups | 3-tier DLP (Open / Restricted / Locked) |
| L5 | VPC Endpoints | Private Link (no internet transit) |
| L6 | DNS Firewall | 5 AWS threat lists + custom block |
| L7 | IAM + DLP | Per-model access control, budget Deny Policy, file restrictions |

## AI Assistant — Hybrid Architecture
```
Dashboard (fast, real-time streaming):
  Browser → /api/ai → Bedrock Converse API (direct)
  → Token-level SSE streaming, 1~5 sec, 3 inline tools

Slack/External (shared, multi-client):
  Slack Bot → /api/ai/runtime → AgentCore Runtime → Gateway (MCP) → Lambda
  → Full response after processing, 10~20 sec, 8 tools

Both share: AgentCore Memory (per-user session isolation)
```

## Task Definition Specifications
| Task Definition | OS | vCPU | Memory | Use Case |
|----------------|-----|------|--------|----------|
| devenv-ubuntu-light | Ubuntu 24.04 | 1 | 4 GiB | Lightweight, docs |
| devenv-ubuntu-standard | Ubuntu 24.04 | 2 | 8 GiB | General dev (default) |
| devenv-ubuntu-power | Ubuntu 24.04 | 4 | 12 GiB | Large builds, ML |
| devenv-al2023-light | Amazon Linux 2023 | 1 | 4 GiB | AWS-native lightweight |
| devenv-al2023-standard | Amazon Linux 2023 | 2 | 8 GiB | AWS-native general |
| devenv-al2023-power | Amazon Linux 2023 | 4 | 12 GiB | AWS-native large |
