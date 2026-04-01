# Project Context

## Overview
CC-on-Bedrock: AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.
CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 인프라 구현.

## Tech Stack
- **IaC:** AWS CDK v2 (TypeScript), Terraform >= 1.5, CloudFormation (YAML)
- **Container:** Docker (Ubuntu 24.04 / Amazon Linux 2023 ARM64)
- **Frontend:** Next.js 14+ (App Router), Tailwind CSS, Recharts
- **Auth:** Amazon Cognito + NextAuth.js
- **Backend Services:** DynamoDB (usage tracking), code-server, Claude Code CLI, Kiro CLI
- **AWS Services:** ECS (EC2 Mode), ALB, CloudFront, DynamoDB, EventBridge, Lambda, EFS, Route 53, Secrets Manager, KMS
- **AI Models:** Bedrock Opus 4.6 (`global.anthropic.claude-opus-4-6-v1[1m]`), Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6[1m]`)
- **Region:** ap-northeast-2 (Seoul)

## Project Structure
```
docs/              - Architecture docs, specs, plans, deployment guide, IaC comparison
.claude/           - Claude settings, hooks, skills
tools/             - Scripts, prompts
docker/            - Docker images (devenv Ubuntu/AL2023)
cdk/               - AWS CDK TypeScript (5 active stacks)
terraform/         - Terraform HCL (5 modules)
cloudformation/    - CloudFormation YAML (5 templates) + deploy.sh
shared/nextjs-app/ - Next.js dashboard (analytics, monitoring, admin)
agent/             - Agent configurations, MCP server settings
scripts/           - ECR repos, deployment verification
tests/             - Container integration tests, E2E tests
```

## Portability & Reusability Rules (CRITICAL)
- **도메인, Account ID, Region은 하드코딩 금지** — CDK config, 환경변수, SSM Parameter Store로 관리
- **스택 삭제 후 재배포가 완벽히 동작해야 함** — 수동 리소스 생성 금지, 모든 리소스는 CDK로 관리
- **S3 deploy 경로 통일**: `s3://{prefix}-deploy-{accountId}/dashboard-deploy.tar.gz` (standalone tar)
- **Cognito 자격 증명**: SSM Parameter Store (`/cc-on-bedrock/cognito/client-id`, `/cc-on-bedrock/cognito/client-secret`)에서 UserData가 부팅 시 읽음
- **Secret**: Secrets Manager에 저장, CDK에서 `fromSecretNameV2` 또는 `fromSecretCompleteArn`으로 참조
- **Cross-stack 참조 금지**: CloudFormation export 대신 SSM Parameter Store 또는 direct import 사용
- **IAM role은 CDK에서 생성** — CLI로 수동 생성한 role은 CDK import(`fromRoleName`)하거나 CDK로 재생성
- **Docker 이미지**: ECR에 push 후 task definition에서 참조. 이미지 빌드는 ARM64 ECS 인스턴스에서 수행
- **환경변수 우선순위**: CDK config → SSM Parameter → Secrets Manager → 기본값

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
