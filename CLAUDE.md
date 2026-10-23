# CC-on-Bedrock

Multi-user Claude Code (and OpenAI Codex CLI) development platform on Amazon Bedrock, with central usage, budget and IAM governance.

## Where current truth lives

- `docs/decisions/BASELINE.md` is the current-truth index for decisions (North Star, invariants, gated/deferred items, decision index). Read it before reasoning about architecture.
- `docs/architecture.md` is the architecture SSOT. Module `CLAUDE.md` files hold module-level detail.
- `docs/decisions/ADR-*.md` is the decision log. `docs/decisions/archive/` and `docs/history/` are historical; treat them as past design unless the user asks about history. Legacy ADR numbers that still appear in code comments (e.g. "ADR-032", "ADR-034") map to the consolidated ADRs through `docs/history/ADR-MAPPING.md`.

## Deployment profiles

Terraform `deployment_mode` selects one of two profiles (ADR-006 amendment 2026-10-23):
- **`governance`** (default): admin dashboard (usage, cost, budgets, approvals) plus the local installer (`curl <dashboard>/api/install | bash`). Users run Claude Code / Codex on their own PC; the CLI signs in with Cognito and gets 1h STS credentials for their per-user role and inference profile, renewed through `credential_process`. No Bedrock API key, no EC2.
- **`devenv`**: everything in `governance` plus per-user ARM64 EC2 DevEnvs (code-server, Claude Code, Kiro, Codex) behind CloudFront (ADR-002/003), the OTEL collector and the EC2 idle/hibernate schedules. Local mode keeps working alongside.
The deprecated `governance_only` bool overrides `deployment_mode` when set (`true` = governance, `false` = devenv), so older tfvars keep their profile.

## Stack

- IaC: Terraform >= 1.5 is the only IaC (ADR-001). State lives in the S3 backend `cc-on-bedrock-tfstate-{account}`. Lambda sources live in repo-root `lambda/`, and Terraform packages them with `archive_file`.
- Compute: per-user EC2 DevEnv (ADR-002); the dashboard runs on an EC2 Auto Scaling group that pulls the Next.js container from a Terraform-managed ECR repo (ADR-011); the nginx router and OTel collectors run on ECS Fargate.
- Frontend: Next.js 14 (App Router), Tailwind CSS, Recharts. Auth: Cognito + NextAuth (ADR-004).
- Data: DynamoDB for usage, routing, instances and limits. Usage comes from Application Inference Profiles + Bedrock Invocation Logs (ADR-005), not account-wide CloudWatch metrics.
- Models (Terraform defaults in `terraform/variables.tf`): Opus `global.anthropic.claude-opus-4-8`, Sonnet `global.anthropic.claude-sonnet-5`; Codex uses `codex_model_id` (`global.openai.gpt-*`, ADR-014).
- Region: ap-northeast-2 by default, configurable.

## Layout

```
terraform/         Terraform root + 8 modules (network, security, ecs-devenv, ec2-devenv, usage-tracking, dashboard, local-governance, waf)
lambda/            Python Lambda handlers packaged by Terraform
shared/nextjs-app/ Next.js dashboard (user portal, admin, analytics, monitoring)
docker/            DevEnv images (baked into AMIs), dashboard, nginx, OTel collector
scripts/           Prerequisite checks, ECR/AMI/image builds, verification, PR-review tooling
tools/             cc-bedrock-local.sh (Local Governance Mode CLI)
agent/             AgentCore Runtime AI assistant (Strands + MCP Gateway)
tests/             Fast gate, unit, integration and container tests
docs/              Architecture, decisions, runbooks, deployment guide
```

## Hard rules

These apply to every change. If a task seems to require breaking one, stop and ask.

- **Terraform only.** Do not add CDK, CloudFormation or another deployment IaC; ADR-001 retired them. Every resource, IAM role and the permission boundary is created in Terraform, so `destroy` followed by `apply` reproduces the platform. A role created by hand must be imported into or recreated in Terraform.
- **No hardcoded domain, account ID or region.** Use Terraform variables (`terraform.tfvars`), SSM Parameter Store or `data` sources so the stack stays portable across accounts.
- **Ingress goes through CloudFront.** Never allow `0.0.0.0/0` or `::/0` ingress on a security group, and never put a public IP or public listener directly on compute. Load balancers are internal, reached only through CloudFront VPC origins, and admit only the CloudFront VPC-origin security group plus the `X-Custom-Secret` header (ADR-015).
- **Cognito self sign-up stays off** (`allow_admin_create_user_only = true`). Accounts are admin-created or invited.
- **Keep BASELINE in sync.** A new ADR, or any flag/status change, updates `BASELINE.md` §3 (or §2) in the same PR; without that the change is not considered live. Retired ADR numbers are never reused.
- Secrets live in Secrets Manager or SecureString SSM parameters referenced from Terraform. Cross-module references use module outputs, `data` sources or SSM rather than export/import patterns.

## Conventions

- Language (ADR-013): new or substantially rewritten docs, ADRs and code comments are English. Existing Korean or bilingual docs stay valid until their own maintenance update, and a narrow edit does not require translating the file. PR review instructions and output are English. Operator conversation and product UI may be Korean.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`, `refactor:`); `.claude/hooks/commit-msg.sh` checks the format.
- Subnet CIDRs are deploy-time inputs. IAM roles are created in the consuming Terraform module to avoid cross-module cycles.
- DLP security policy is per user: `open` / `restricted` / `locked`.
- The dashboard image tag is immutable (`dashboard_image_tag`, never `latest`) because ASG instance refresh depends on the tag string changing.

## Keeping docs current

Update documentation in the same PR when a change actually alters what it describes:

- A change to an architecture decision or module contract updates `docs/architecture.md` and the relevant module `CLAUDE.md`.
- Write an ADR only when a real decision or trade-off is made, or when the user asks for one. Use the next number after the highest `docs/decisions/ADR-*.md` (BASELINE §3 states it), follow `_TEMPLATE.md`, and update BASELINE as above.
- A new module or Lambda gets a short `CLAUDE.md` when its contract is not obvious from the code.
- A new operational procedure goes in `docs/runbooks/`.

Routine fixes, refactors and plans that do not change a decision need no doc or ADR changes.

## Commands

```bash
# Fast gate: tsc + vitest, pytest, CLI syntax, PR-review stub, boundary invariant, terraform fmt -check
bash tests/run-all.sh

# Terraform
# Partial S3 backend (`backend "s3" {}` in providers.tf): pass settings at init (use_lockfile needs Terraform >= 1.10)
terraform -chdir=terraform init \
  -backend-config="bucket=cc-on-bedrock-tfstate-<ACCOUNT_ID>" \
  -backend-config="key=cc-on-bedrock/terraform.tfstate" \
  -backend-config="region=<REGION>" -backend-config="encrypt=true" -backend-config="use_lockfile=true"
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply        # persistent data EBS volumes survive destroy

# Images and AMIs (ARM64)
bash scripts/01-create-ecr-repos.sh                                       # non-Terraform repos (devenv, nginx)
IMAGE_TAG=$(git rev-parse --short HEAD) bash scripts/05-build-docker-images.sh dashboard
bash scripts/build-ami.sh ubuntu                                          # or al2023; registers the AMI ID in SSM

# Dashboard
cd shared/nextjs-app && npm install && npm run dev
cd shared/nextjs-app && npx tsc --noEmit && npx vitest run

# Integration and post-deploy verification
bash tests/integration/test-e2e.sh
bash tests/docker/test-devenv.sh
bash scripts/verify-deployment.sh <domain>

# PR-review tooling (offline)
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'
```

Fresh dashboard bootstrap is two-phase; see `terraform/CLAUDE.md`.

## PR review

CI runs a Codex lens panel and a Claude chair (`ROLE_REVIEW=0`; owner decision 2026-10-21, ADR-013 amendment). Codex `global.openai.gpt-6.1-sol` reviews each lens L2–L5 in parallel. Claude Opus 5.5 runs as a tool-less chair: it reviews the same diff itself, adjudicates the Codex findings and emits the single `VERDICT`. A lens Codex did not complete forces `VERDICT: FAIL`. Diffs over 12,000 lines or 512,000 bytes are blocked, never truncated. Kiro is not in the CI panel. The specialist protocol (`docs/pr-review-specialists.md`) is retained behind `ROLE_REVIEW=1`. Failed or incomplete required output is never a clean review, and the chair cannot waive a coverage failure.

PR review instructions, guides, related ADRs and review output are English-only.
