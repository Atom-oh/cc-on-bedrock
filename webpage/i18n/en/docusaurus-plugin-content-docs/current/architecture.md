# Architecture

CC-on-Bedrock's architecture is designed with high availability, security, and individual user isolation in mind.

## Infrastructure Stack Configuration

The system consists of 5 core stacks, each manageable and deployable independently.

| Stack | Key Resources |
|-------|-----------|
| **01-Network** | VPC (10.100.0.0/16), NAT Gateway, VPC Endpoints, DNS Firewall |
| **02-Security** | Cognito (Hosted UI), ACM, KMS, Secrets Manager, IAM Roles |
| **03-Usage Tracking** | DynamoDB, Lambda (usage-tracker), EventBridge, CloudTrail |
| **04-ECS DevEnv** | ECS Cluster (EC2 mode), Task Definitions, EFS, ALB, CloudFront |
| **05-Dashboard** | Next.js Standalone, EC2 ASG, ALB, CloudFront, S3 |

## Container Architecture

Each user is assigned an independent ECS Task:

- **1 ECS Task**: Isolated container environment (code-server + Claude Code + Kiro).
- **1 ENI**: Unique Private IP (`awsvpc` network mode).
- **1 IAM Role**: User-specific role for individual budget control.
- **1 ALB Target Group**: Host-based routing (`{subdomain}.dev.domain.com`).
- **1 EFS Directory**: Per-user isolated file system storage.

## Hybrid AI Architecture

The dashboard and external channels (like Slack) provide AI services through different paths:

### Dashboard (Fast Streaming)
- **Path**: Browser → /api/ai → Bedrock Converse API (Direct)
- **Features**: Token-level SSE streaming, 1-5 second response time, inline tool support.

### Slack/External Channels (Shared Runtime)
- **Path**: Slack Bot → /api/ai/runtime → AgentCore Runtime → Gateway (MCP) → Lambda
- **Features**: Response after full processing, 10-20 second response time, supports 8+ professional tools.

Both paths share user session isolation and conversation history via **AgentCore Memory**.
