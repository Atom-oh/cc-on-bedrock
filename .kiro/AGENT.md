# CC-on-Bedrock Agent

## Overview
CC-on-Bedrock: AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.
CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 인프라 구현.

## Tech Stack
- **IaC:** AWS CDK v2 (TypeScript), Terraform >= 1.5, CloudFormation (YAML)
- **Container:** Docker (Ubuntu 24.04 / Amazon Linux 2023 ARM64)
- **Frontend:** Next.js 14+ (App Router), Tailwind CSS, Recharts
- **Auth:** Amazon Cognito (OAuth 2.0 + OIDC) + NextAuth.js
- **AI Models:** Bedrock Opus 4.6, Sonnet 4.6, Haiku 4.5 (global inference profiles)
- **AI Framework:** Strands Agents, MCP Protocol, AgentCore Runtime/Gateway/Memory
- **Backend:** DynamoDB, Lambda, EventBridge, EFS, ECS (EC2 mode)
- **Networking:** CloudFront, ALB, VPC Endpoints, DNS Firewall, NAT Gateway
- **Security:** KMS, Secrets Manager, IAM (per-user roles), Security Groups (3-tier DLP)
- **Region:** ap-northeast-2 (Seoul)

## Project Structure
```
cdk/               - AWS CDK TypeScript (5 stacks)
terraform/         - Terraform HCL (4 modules)
cloudformation/    - CloudFormation YAML (4 templates) + deploy.sh
shared/nextjs-app/ - Next.js dashboard (7 pages, 8 API routes)
agent/             - AgentCore agent (Strands + MCP Gateway + 3 Lambda tools)
docker/            - Docker images (devenv Ubuntu/AL2023)
scripts/           - ECR repos, deployment verification, test data
tests/             - Container integration tests, E2E tests
docs/              - Architecture, deployment guide, IaC comparison, ADRs
output/            - Architecture docs (bilingual ko/en)
```

## Architecture — 5 Stacks
| Stack | Resources |
|-------|-----------|
| 01-Network | VPC (10.100.0.0/16), Public/Private Subnets (2 AZ), NAT GW x2, VPC Endpoints x8, DNS Firewall |
| 02-Security | Cognito (Hosted UI + OAuth 2.0), ACM, KMS, Secrets Manager, IAM Roles, SNS |
| 03-Usage Tracking | DynamoDB, Lambda (usage-tracker + budget-check), EventBridge, CloudTrail |
| 04-ECS DevEnv | ECS Cluster (EC2 mode x8), 6 Task Definitions, EFS, ALB, CloudFront |
| 05-Dashboard | Next.js Standalone, EC2 ASG, ALB, CloudFront, S3 Deploy Bucket |

## AgentCore (CDK 외부)
| Resource | Purpose |
|----------|---------|
| Runtime (cconbedrock_assistant_v2) | Strands Agent (PUBLIC mode) |
| Gateway (cconbedrock-gateway) | MCP protocol, 3 Lambda targets |
| Memory (cconbedrock_memory) | Per-user conversation history |
| Lambda Tools (3 functions, 8 MCP tools) | ECS, CloudWatch, DynamoDB |

## Conventions
- Korean for docs/communication, English for code/comments
- Commit messages: conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- CloudFront → ALB security: Prefix List + X-Custom-Secret header
- DLP security policies: open/restricted/locked (per-user configurable)
- Per-user IAM Roles: `cc-on-bedrock-task-{subdomain}` with dynamic Deny Policy
- Bedrock Direct Mode: Claude Code → ECS Task Role → Bedrock (no proxy)
- IAM Role은 사용하는 스택에서 생성 (cross-stack cyclic ref 방지)

## Key Commands
```bash
# Docker
cd docker && bash build.sh all all             # Build + push to ECR

# CDK
cd cdk && npm install && npx cdk deploy --all

# Terraform
cd terraform && terraform init && terraform apply

# CloudFormation
cd cloudformation && bash deploy.sh

# Dashboard
cd shared/nextjs-app && npm install && npm run dev

# AgentCore Lambda + Gateway
ACCOUNT_ID=xxx python3 agent/lambda/create_targets.py

# Tests
bash tests/integration/test-e2e.sh
bash scripts/verify-deployment.sh example.com
```

## Auto-Sync Rules
- IaC 변경 → 해당 steering doc 업데이트
- Architecture decision → `docs/decisions/ADR-NNN-title.md` 생성
- Infrastructure 변경 → `docs/architecture.md` 업데이트
- Dashboard page/API 추가 → nextjs-dashboard steering 업데이트
