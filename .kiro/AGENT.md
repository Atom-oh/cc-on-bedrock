# CC-on-Bedrock Agent

## Overview
CC-on-Bedrock: AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.
CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 인프라 구현.

## Tech Stack
- **IaC:** AWS CDK v2 (TypeScript), Terraform >= 1.5, CloudFormation (YAML)
- **Container:** Docker (Ubuntu 24.04 / Amazon Linux 2023 ARM64)
- **Frontend:** Next.js 14+ (App Router), Tailwind CSS, Recharts
- **Auth:** Amazon Cognito + NextAuth.js
- **AI Models:** Bedrock Opus 4.6, Sonnet 4.6, Haiku 4.5 (global inference profiles)
- **Agent:** AgentCore Runtime + Gateway, Strands SDK
- **Proxy:** LiteLLM (17 model aliases, budget tracking)
- **Dev Tools:** code-server, Claude Code CLI, Kiro CLI
- **AWS Services:** ECS (EC2), ALB, CloudFront, RDS PostgreSQL, ElastiCache Valkey, EFS, Route 53, KMS, Secrets Manager, CloudWatch
- **Region:** ap-northeast-2 (Seoul)

## Project Structure
```
agent/             - AgentCore Runtime Agent (Strands + 5 tools)
docker/            - Docker images (devenv Ubuntu/AL2023, litellm)
cdk/               - AWS CDK TypeScript (5 stacks)
terraform/         - Terraform HCL (5 modules)
cloudformation/    - CloudFormation YAML (5 templates) + deploy.sh
shared/nextjs-app/ - Next.js 14 Dashboard (analytics, monitoring, admin, AI assistant)
scripts/           - ECR repos, deployment verification, test data generation
tests/             - Container integration tests, E2E tests
docs/              - Architecture docs, deployment guide, IaC comparison, ADRs
```

## Architecture (5 Stacks)
| Stack | Description | Key Resources |
|-------|-------------|---------------|
| 01 Network | 네트워크 기반 | VPC (3-tier), NAT GW x2, VPC Endpoints x8, Route 53 |
| 02 Security | 인증/보안 | Cognito, ACM, KMS, Secrets Manager, IAM, DLP 정책 |
| 03 LiteLLM | AI 프록시 | EC2 ASG x2, Internal ALB, RDS PostgreSQL, Serverless Valkey |
| 04 ECS DevEnv | 개발환경 | ECS Cluster (EC2), 6 Task Defs, EFS, ALB, CloudFront |
| 05 Dashboard | 관리 대시보드 | Next.js 14, EC2 ASG, ALB, CloudFront |

## Conventions
- Korean for docs/communication, English for code/comments
- Commit messages: conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- CloudFront → ALB security: Prefix List + X-Custom-Secret header
- DLP security policies: open/restricted/locked (per-user configurable)
- 6 Task Definitions: Ubuntu/AL2023 × Light/Standard/Power
- EFS → `/home/coder` for persistent storage across container restarts
- IAM Role은 사용하는 스택에서 생성 (cross-stack cyclic ref 방지)

## Key Commands
```bash
# Docker images
cd docker && bash build.sh all all             # Build + push to ECR
bash scripts/create-ecr-repos.sh               # Create ECR repos

# CDK
cd cdk && npm install && npx cdk deploy --all

# Terraform
cd terraform && terraform init && terraform apply

# CloudFormation
cd cloudformation && bash deploy.sh

# Next.js Dashboard
cd shared/nextjs-app && npm install && npm run dev

# Tests
bash tests/integration/test-e2e.sh             # Full E2E test
bash scripts/verify-deployment.sh example.com  # Post-deploy verify (23 items)
```

## Auto-Sync Rules
When making code changes, keep documentation in sync:
- New directory under IaC folder → Create steering doc for that module
- CDK/Terraform/CloudFormation changed → Update corresponding steering doc
- Docker image changed → Update docker steering doc
- Dashboard page/API added → Update nextjs-app steering doc
- Architecture decision → Create ADR in `docs/decisions/ADR-NNN-title.md`
- Infrastructure changed → Update `docs/architecture.md`
