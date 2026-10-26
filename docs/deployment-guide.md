# CC-on-Bedrock Deployment Guide

[BASELINE](decisions/BASELINE.md) and [architecture](architecture.md) define the
current contracts. Run commands from the repository root. This guide describes
Terraform deployment; it does not deploy resources as part of documentation sync.

## Prerequisites and inputs

Use AWS CLI v2, Terraform >= 1.7, Docker with Buildx, Node.js 20, Python with
pytest, jq and Git. The S3 lockfile commands below require Terraform >= 1.10.
Check local prerequisites with `bash scripts/00-check-prerequisites.sh`.

Authenticate the deployment profile and choose its region:

```bash
export AWS_REGION="<deployment-region>"
export AWS_DEFAULT_REGION="$AWS_REGION"
export TF_STATE_BUCKET="<existing-state-bucket>"
aws sts get-caller-identity
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Edit tfvars before continuing. Required deployment inputs include the existing
`vpc_id`, subnet ID lists, `domain_name`, region and `dashboard_image_tag`.
`public_subnet_ids` is accepted as an input; platform compute and load balancers
use private networking. Provide suitable private/isolated subnets and egress.
Remove interface endpoint services already present with private DNS; provide
existing endpoint SG IDs for the locked DLP tier.

The network module looks up the existing public Route 53 zone and creates
platform records, selected missing interface endpoints and DNS Firewall
resources. It does not create the VPC, subnets, NAT, IGW or gateway endpoints.
The shared VPC and public zone must exist before initialization/planning.

Select the profile explicitly:

| Profile | Resources |
|---|---|
| `governance` (default) | Dashboard, local installer, Cognito, STS issuer, metering and budget controls |
| `devenv` | Governance resources plus per-user EC2, nginx routing, native OTEL collectors and lifecycle schedules |

The deprecated `governance_only` overrides `deployment_mode` when set. An unset
mode with existing DevEnv SGs fails planning. Explicitly switching a DevEnv
stack to governance removes its DevEnv resources; review that change separately.

Model IDs are deployment configuration. `terraform/variables.tf` and the sample
tfvars contain the current defaults; confirm access in the chosen account and
region. Codex uses bedrock-runtime Responses and `global.openai.*` profiles,
with role-based attribution rather than application inference profiles.

## Initialize state before bootstrap

Use a separately provisioned, encrypted and versioned S3 backend. Keep its
bucket, locking and recovery lifecycle outside the platform destroy plan.

```bash
terraform -chdir=terraform init \
  -backend-config="bucket=${TF_STATE_BUCKET:?}" \
  -backend-config="key=cc-on-bedrock/terraform.tfstate" \
  -backend-config="region=${AWS_REGION:?}" \
  -backend-config="encrypt=true" -backend-config="use_lockfile=true"
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform validate
```

Do not run platform apply with an accidental local backend. Backend settings
and tfvars are deployment inputs, not credentials to commit.

## Bootstrap and publish the dashboard image

The dashboard ECR repository is owned by `module.security`. On a fresh deploy,
create it after configuration/initialization and before publishing its image:

```bash
terraform -chdir=terraform plan \
  -target=module.security.aws_ecr_repository.dashboard -out=dashboard-ecr.tfplan
terraform -chdir=terraform apply dashboard-ecr.tfplan
export IMAGE_TAG="$(git rev-parse --short HEAD)"
bash scripts/05-build-docker-images.sh dashboard
```

Set `dashboard_image_tag` in tfvars to exactly `$IMAGE_TAG`. The container runs
on an ARM64 EC2 Auto Scaling group; changing the tag triggers instance refresh.
Terraform rejects `latest` for this input. Targeted apply is only the repository
bootstrap; always inspect a full plan afterward.

## Optional DevEnv prerequisites

Skip this section for governance. For `devenv`, prepare router/collector images
before a full apply. Build the custom DevEnv AMIs **after the infrastructure apply
and before the first user launch**. The Terraform launch template can use its base
AL2023 AMI during bootstrap; user lifecycle launch selects the baked AMI from SSM.
`scripts/build-ami.sh` requires the deployed dashboard EC2 IAM role and DevEnv
open SG, which the dashboard ECR bootstrap alone does not create.

Run `bash scripts/build-ami.sh ubuntu` or `al2023` after those prerequisites
exist. It uses temporary EC2 and registers AMI IDs under
`/cc-on-bedrock/devenv/ami-id/{os}`. Its subnet lookup still relies on legacy
`cc-on-bedrock` Name tags, not the root tfvars subnet lists; verify it selects
the intended private subnet/VPC. A BYO VPC without those tags is not supported
by this helper as-is. Resolve the builder's discovery before execution rather
than assuming Terraform's subnet inputs are honored. This is a live build,
not a local validation command.

Repository ownership has a known tooling inconsistency: the historical
`scripts/01-create-ecr-repos.sh` creates nginx as well as devenv/collector repos,
but `module.ecs_devenv[0].aws_ecr_repository.nginx` also owns nginx. Bootstrap
that Terraform resource first, or import an existing nginx repo at that address
before planning. Do not blindly create a duplicate repository. Existing manually
created repositories must be reconciled with Terraform ownership before reuse.

`docker/build.sh` supports explicit devenv/dashboard/collector targets. Its `all`
target still references removed LiteLLM and it has no nginx target.
`scripts/05-build-docker-images.sh all` builds the devenv and dashboard images,
not nginx or the collector. Build/push nginx from `docker/nginx/` with Docker and
use the image URI/tag expected by `terraform/modules/ecs-devenv/main.tf`.
The rollup collector currently expects `cc-on-bedrock/otel-collector:latest`;
`IMAGE_TAG=latest bash docker/build.sh all otel-collector` is the explicit
collector build/push path. Docker pushes require ECR login and a Buildx builder.
These helper gaps are documented here; they are not a second IaC implementation.

New DevEnvs have an OS root and persistent `/home/coder` data EBS. The data volume
is encrypted GP3, `DeleteOnTermination=false`, and reattached through canonical
subdomain tags and stored `dataVolumeId`. ADR-002 intends an ephemeral root,
but current runtime and Terraform mappings retain it (`false`); inventory roots
as well as data volumes during recovery. This guide does not alter that behavior.

## Review and apply the full deployment

```bash
terraform -chdir=terraform plan -out=deployment.tfplan
terraform -chdir=terraform apply deployment.tfplan
terraform -chdir=terraform output -raw deployment_mode
terraform -chdir=terraform output -raw dashboard_url
```

Review replacements, IAM/boundaries, protected resources and data loss in the
plan. Saved plan files may contain sensitive configuration; keep them out of Git.
For `devenv`, complete the AMI build described above before users create their
first environment.

| Module | Responsibility |
|---|---|
| `network` | Existing VPC/subnet/zone lookup, missing interface endpoints, DNS Firewall |
| `security` | Cognito, ACM, KMS, secrets, IAM boundary and dashboard ECR |
| `dashboard` | CloudFront VPC origin, internal ALB, EC2 ASG and Next.js container |
| `local-governance` | Public Cognito client integration, STS issuer, token counters/enforcer/reset |
| `usage-tracking` | Invocation logs, usage/budget Lambdas, audit and optional OTEL rollup |
| `ecs-devenv` | Optional internal NLB, nginx Fargate and routing configuration |
| `ec2-devenv` | Optional DevEnv launch template, instance IAM and DLP SGs |
| `waf` | CloudFront WAF protection |

## Invite users and verify

Use `bash scripts/04-setup-cognito-auth.sh --admin-email admin@example.com` for
the initial native Cognito setup, after reviewing its discovery/configuration
steps. The supported baseline has admin-created accounts and self-signup off;
the script's federation options are deferred, not an enabled deployment feature.
Complete the temporary-password challenge at dashboard `/login`.

Invite later users through Admin → Users. Configure budgets/limits in the
dashboard, then follow [local onboarding](runbooks/local-governance-onboarding.md).
Dashboard Cognito configuration is injected by Terraform; `NEXTAUTH_SECRET` is
loaded from SecureString SSM at boot.

Verify the selected profile rather than interpreting absent DevEnv resources as
failures in governance:

- Dashboard URL serves `/api/health`; login/password recovery and admin RBAC work.
- Native `claude`/`codex`, configured by `cc-bedrock-local setup` and login,
  obtain the user's one-hour renewable STS credentials.
- Real test invocations appear in usage records; Claude and Codex share limits.
- With `devenv`, verify edge auth, nginx routes, `/home/coder` persistence and
  native telemetry through `otel_rollup_collector_endpoint`.

The existing `scripts/verify-deployment.sh` still assumes an ECS dashboard,
fixed dashboard subdomain and DevEnv resources. Treat it as a partial diagnostic,
not the acceptance gate for governance or the EC2-hosted dashboard. Integration
checks require a deployed environment and appropriate isolated test identities.

For recovery use [instance recovery](runbooks/instance-recovery.md). For lifecycle
changes use [destroy/redeploy](runbooks/full-teardown-redeploy.md); shared network,
backend and persistent data need separate preservation review.
