# Project Context

## Source of Truth (read FIRST)
- **Decisions / current truth:** `docs/decisions/BASELINE.md` — single current-truth index (North Star, invariants, frozen/gated, decision index). Read before reasoning about any architecture decision.
- **Architecture detail (SSOT):** `docs/architecture.md`.
- `docs/decisions/ADR-*.md` = decision log (detail). **`docs/decisions/archive/` and `docs/history/` are HISTORICAL — NOT current; do not read as present design unless explicitly asked.**
- A new ADR or flag/status change MUST update `BASELINE.md` (§3/§2) in the same PR (anti-drift); do not reuse retired ADR numbers.

## Overview
CC-on-Bedrock: AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.
**Terraform(HCL)이 유일한 IaC** (ADR-033: CDK·CloudFormation 폐기, 2026-06). Lambda 소스는 `lambda/` (repo root), TF가 archive_file로 패키징. State는 S3 backend(`cc-on-bedrock-tfstate-{account}`).

두 가지 배포 프로파일 지원:
- **EC2 DevEnv 모드** (기본, ADR-004): per-user EC2에서 Claude Code 실행
- **Local Governance Mode** (ADR-014, GATED): EC2 없이 거버넌스 레이어만 배포, 사용자가 로컬 PC에서 Bedrock 직접 호출. `governanceOnly` 동등 Terraform 변수는 **미구현(follow-up)** — 현재는 전체 모듈이 함께 배포됨 (`terraform/CLAUDE.md` 참조). 두 모드 공존 가능.

## Tech Stack
- **IaC:** Terraform >= 1.5 (HCL) 단일 정본 — S3 backend state (ADR-033/BASELINE §1)
- **Container:** Docker (Ubuntu 24.04 / Amazon Linux 2023 ARM64)
- **Frontend:** Next.js 14+ (App Router), Tailwind CSS, Recharts
- **Auth:** Amazon Cognito + NextAuth.js
- **Backend Services:** DynamoDB (usage tracking), code-server, Claude Code CLI, Kiro CLI
- **Compute:** EC2 per-user DevEnv (ARM64, ADR-004), ECS (Dashboard Ec2Service + Nginx Fargate)
- **AWS Services:** EC2, ECS, ALB, CloudFront, DynamoDB, EventBridge, Lambda, Route 53, Secrets Manager, KMS
- **AI Models:** Bedrock Opus 4.8 (`global.anthropic.claude-opus-4-8[1m]`), Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6[1m]`)
- **Region:** ap-northeast-2 (Seoul)

## Project Structure
```
docs/              - Architecture docs, specs, plans, deployment guide, IaC comparison
.claude/           - Claude settings, hooks, skills
tools/             - Scripts, prompts, cc-bedrock-local.sh (Local Mode CLI wrapper)
docker/            - Docker images (devenv Ubuntu/AL2023, dashboard, nginx, otel-collector)
terraform/         - Terraform HCL 단일 IaC (8 modules: network, security, ecs-devenv, ec2-devenv, usage-tracking, dashboard, local-governance, waf) + main.tf/variables.tf/outputs.tf/providers.tf
lambda/            - Lambda 소스 (Python; sts-issuer, nginx-config-gen, token-limit-enforcer, user-role-provisioner 등) — TF가 archive_file로 패키징
shared/nextjs-app/ - Next.js dashboard (analytics, monitoring, admin)
agent/             - Agent configurations, MCP server settings
scripts/           - ECR repos, AMI build, deployment verification
tests/             - Container integration tests, E2E tests
```

## Portability & Reusability Rules (CRITICAL)
- **도메인, Account ID, Region은 하드코딩 금지** — Terraform variables(`terraform.tfvars`), SSM Parameter Store로 관리
- **destroy 후 재배포가 완벽히 동작해야 함** — 수동 리소스 생성 금지, 모든 리소스는 Terraform 모듈로 관리 (state = S3 backend)
- **S3 deploy 경로 통일**: `s3://{prefix}-deploy-{accountId}/dashboard-deploy.tar.gz` (standalone tar)
- **Cognito 자격 증명**: SSM Parameter Store (`/cc-on-bedrock/cognito/client-id`, `/cc-on-bedrock/cognito/client-secret`)에서 UserData가 부팅 시 읽음
- **Secret**: Secrets Manager에 저장, Terraform에서 `aws_secretsmanager_secret`/data source로 참조
- **모듈 간 참조**: SSM Parameter Store 또는 Terraform module output/`data` source 사용 (cross-stack export 패턴 금지)
- **IAM role은 Terraform에서 생성** — CLI로 수동 생성한 role은 `terraform import` 하거나 Terraform으로 재생성. permission boundary도 Terraform 정본 (ADR-034)
- **Docker 이미지**: Dashboard → ECR push 후 ECS task definition 참조. DevEnv → AMI 기반 EC2 직접 실행
- **환경변수 우선순위**: Terraform variable → SSM Parameter → Secrets Manager → 기본값

## Conventions
- Korean for docs/communication, English for code/comments
- Commit messages: conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- All subnet CIDRs are deploy-time input parameters
- CloudFront -> ALB security: Prefix List + X-Custom-Secret header
- DLP security policies: open/restricted/locked (per-user configurable)
- IAM roles created in the consuming Terraform module (avoid cross-module cyclic refs)

## Key Commands
```bash
# Docker images
cd docker && bash build.sh build all           # Build all images
cd docker && bash build.sh all all             # Build + push to ECR (ARM64)
bash scripts/01-create-ecr-repos.sh            # Create ECR repos

# DevEnv AMI (per-user EC2, ADR-004)
bash scripts/build-ami.sh ubuntu               # Build Ubuntu AMI + register SSM param
bash scripts/build-ami.sh al2023               # Build AL2023 AMI + register SSM param

# Terraform (단일 IaC)
terraform -chdir=terraform init                # Initialize (S3 backend)
terraform -chdir=terraform fmt -recursive      # Format
terraform -chdir=terraform validate            # Validate
terraform -chdir=terraform plan                # Preview
terraform -chdir=terraform apply               # Deploy all 8 modules
terraform -chdir=terraform destroy             # Tear down (persistent data EBS는 유지)

# Next.js Dashboard
cd shared/nextjs-app && npm install && npm run dev   # Dev server
cd shared/nextjs-app && npx tsc --noEmit             # Type check
cd shared/nextjs-app && npx vitest run               # Unit tests (vitest)

# Tests
bash tests/run-all.sh                          # Fast gate: vitest + pytest + ADR invariants (needs python3 -m pytest)
bash tests/integration/test-e2e.sh             # Full E2E test
bash tests/docker/test-devenv.sh               # Container tests
bash scripts/verify-deployment.sh example.com  # Post-deploy verify
```

---

## Auto-Sync Rules

Rules below are applied automatically after Plan mode exit and on major code changes.

### Post-Plan Mode Actions
After exiting Plan mode (`/plan`), before starting implementation:

1. **Architecture decision made** -> Update `docs/architecture.md` (SSOT)
2. **Technical choice/trade-off made** -> Create `docs/decisions/ADR-NNN-title.md` + **같은 PR에서 `docs/decisions/BASELINE.md` §3(또는 §2) 갱신** (anti-drift)
3. **New module added** -> Create `CLAUDE.md` in that module directory
4. **Operational procedure defined** -> Create runbook in `docs/runbooks/`
5. **Changes needed in this file** -> Update relevant sections above

### Code Change Sync Rules
- New directory under `terraform/` (or `lambda/`) -> Must create `CLAUDE.md` alongside
- Terraform module added/changed -> Update `terraform/` CLAUDE.md + `docs/architecture.md`; 결정에 영향 시 BASELINE 갱신
- Lambda source added/changed (`lambda/`) -> Update `lambda/` CLAUDE.md (TF가 패키징하는 함수)
- Docker image changed -> Update `docker/` CLAUDE.md
- Dashboard page/API added -> Update `shared/nextjs-app/` CLAUDE.md
- Infrastructure changed -> Update `docs/architecture.md` Infrastructure section

### ADR Numbering
Find the highest number in `docs/decisions/ADR-*.md` and increment by 1.
Format: `ADR-NNN-concise-title.md`. 새 ADR/flag/status 변경은 **같은 PR에서 `BASELINE.md` (§3/§2)를 갱신**해야 하며(anti-drift), 폐기/통합된 ADR 번호는 재사용하지 않는다.
