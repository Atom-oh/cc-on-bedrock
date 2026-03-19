# Project Context

## Overview
CC-on-Bedrock: AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.
CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 인프라 구현.

## Tech Stack
- **IaC:** AWS CDK v2 (TypeScript), Terraform >= 1.5, CloudFormation (YAML)
- **Container:** Docker (Ubuntu 24.04 / Amazon Linux 2023 ARM64)
- **Frontend:** Next.js 14+ (App Router), Tailwind CSS, Recharts
- **Auth:** Amazon Cognito + NextAuth.js
- **Backend Services:** LiteLLM Proxy, code-server, Claude Code CLI, Kiro CLI
- **AWS Services:** ECS (EC2 Mode), ALB, CloudFront, RDS PostgreSQL, ElastiCache Serverless Valkey, EFS, Route 53, Secrets Manager, KMS
- **AI Models:** Bedrock Opus 4.6 (`global.anthropic.claude-opus-4-6-v1[1m]`), Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6[1m]`)
- **Region:** ap-northeast-2 (Seoul)

## Project Structure
```
docs/              - Architecture docs, specs, plans, deployment guide, IaC comparison
.claude/           - Claude settings, hooks, skills
tools/             - Scripts, prompts
docker/            - Docker images (devenv Ubuntu/AL2023 + LiteLLM)
cdk/               - AWS CDK TypeScript (5 stacks)
terraform/         - Terraform HCL (5 modules)
cloudformation/    - CloudFormation YAML (5 templates) + deploy.sh
shared/nextjs-app/ - Next.js dashboard (analytics, monitoring, admin)
scripts/           - ECR repos, deployment verification
tests/             - Container integration tests, E2E tests
```

## Conventions
- Korean for docs/communication, English for code/comments
- Commit messages: conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- All subnet CIDRs are deploy-time input parameters
- CloudFront -> ALB security: Prefix List + X-Custom-Secret header
- DLP security policies: open/restricted/locked (per-user configurable)
- ECS roles created in consuming stack (avoid CDK cross-stack cyclic refs)

## Key Commands
```bash
# Docker images
cd docker && bash build.sh build all           # Build all images
cd docker && bash build.sh all all             # Build + push to ECR
bash scripts/create-ecr-repos.sh               # Create ECR repos

# CDK
cd cdk && npm install && npx cdk synth --all   # Synthesize
cd cdk && npx cdk deploy --all                 # Deploy all stacks
cd cdk && npx cdk list                         # List stacks

# Terraform
cd terraform && terraform init                 # Initialize
cd terraform && terraform validate             # Validate
cd terraform && terraform apply                # Deploy

# CloudFormation
cd cloudformation && bash deploy.sh            # Deploy all stacks (sequential)
cd cloudformation && bash destroy.sh           # Destroy all stacks (reverse)

# Next.js Dashboard
cd shared/nextjs-app && npm install && npm run dev   # Dev server
cd shared/nextjs-app && npx tsc --noEmit             # Type check

# Tests
bash tests/integration/test-e2e.sh             # Full E2E test
bash tests/docker/test-devenv.sh               # Container tests
bash scripts/verify-deployment.sh example.com  # Post-deploy verify
```

---

## Auto-Sync Rules

Rules below are applied automatically after Plan mode exit and on major code changes.

### Post-Plan Mode Actions
After exiting Plan mode (`/plan`), before starting implementation:

1. **Architecture decision made** -> Update `docs/architecture.md`
2. **Technical choice/trade-off made** -> Create `docs/decisions/ADR-NNN-title.md`
3. **New module added** -> Create `CLAUDE.md` in that module directory
4. **Operational procedure defined** -> Create runbook in `docs/runbooks/`
5. **Changes needed in this file** -> Update relevant sections above

### Code Change Sync Rules
- New directory under any IaC folder -> Must create `CLAUDE.md` alongside
- CDK stack added/changed -> Update `cdk/` CLAUDE.md and `docs/architecture.md`
- Terraform module added/changed -> Update `terraform/` CLAUDE.md
- CloudFormation template added/changed -> Update `cloudformation/` CLAUDE.md
- Docker image changed -> Update `docker/` CLAUDE.md
- Dashboard page/API added -> Update `shared/nextjs-app/` CLAUDE.md
- Infrastructure changed -> Update `docs/architecture.md` Infrastructure section

### ADR Numbering
Find the highest number in `docs/decisions/ADR-*.md` and increment by 1.
Format: `ADR-NNN-concise-title.md`
