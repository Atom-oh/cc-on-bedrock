# Terraform Module

## Role

Terraform HCL is the canonical IaC for this repository.

## Key Files

- `main.tf` - Root module wiring.
- `variables.tf` - Root variables.
- `outputs.tf` - Deployment outputs consumed by the dashboard and operators.
- `providers.tf` - AWS providers, including `us-east-1` alias for CloudFront-scope WAF.
- `modules/network/` - BYO VPC: takes `vpc_id` + subnet IDs (never creates a VPC/subnet/NAT/IGW), adds missing interface endpoints (`interface_endpoint_services`), DNS Firewall; looks up the shared public Route 53 zone as a data source.
- `modules/security/` - Cognito, ACM, KMS, Secrets Manager, IAM, permission boundary.
- `modules/ecs-devenv/` - Shared Nginx router, internal NLB behind a CloudFront VPC origin, routing table, config Lambda, OTEL Collector.
- `modules/ec2-devenv/` - Per-user EC2 DevEnv launch template, EBS GP3, DLP security groups.
- `modules/usage-tracking/` - Bedrock Invocation Logs, usage aggregation, budget checks. Also the
  native OTEL code-activity rollup (ADR-009): raw OTLP S3 bucket with `otlp-metrics/`+`otlp-logs/`
  lifecycle + S3 notifications triggering the rollup Lambda (per-user daily KPI → DynamoDB; needs
  `dynamodb:TransactWriteItems` for per-chunk idempotent markers).
- `modules/local-governance/` - STS issuer, token-limit enforcer, limit reset.
- `modules/dashboard/` - Dashboard EC2 ASG, internal ALB behind a CloudFront VPC origin, CloudFront, and Docker runtime.
- `modules/waf/` - CloudFront-scope WAF.

## Status

All 8 modules are wired into the root `main.tf` (ADR-001). `deployment_mode` picks the profile
(ADR-006 amendment 2026-10-23):
- `"governance"` (default) sets `count = 0` on `ecs_devenv` and `ec2_devenv`, and passes
  `devenv_enabled = false` to `security` (no DevEnv wildcard cert, no dashboard EC2/ECS DevEnv
  policies) and `usage-tracking` (no EC2 idle/EOD/hibernate schedules, no OTEL collector
  Fargate service or NLB; the raw bucket and rollup Lambda stay).
- `"devenv"` deploys everything. The gated resources carry `moved` blocks
  (`modules/{security,usage-tracking}/moved.tf`), so an existing devenv state plans no
  replacements.
- The deprecated `governance_only` bool overrides `deployment_mode` when set. A tfvars file
  with `governance_only = false` stays on devenv; deleting that line switches to governance and
  destroys every DevEnv resource, so set `deployment_mode = "devenv"` first.
- Upgrade guard: when neither `deployment_mode` nor `governance_only` is set, `data.aws_security_groups.existing_devenv` fails the plan if `cc-devenv-open-*` security groups exist in the VPC. Set the mode explicitly to proceed.
- The dashboard receives `DEPLOYMENT_MODE` and hides DevEnv pages; DevEnv lifecycle APIs return
  404 in governance mode.

The task permission boundary `cc-on-bedrock-task-boundary` is authored in `modules/security`
(`aws_iam_policy.task_permission_boundary`, statements `AllowInAccount` + `DenyEscalation`;
ADR-007) and passed to ec2-devenv and local-governance as `task_permission_boundary_arn`.

The dashboard runs the real Next.js standalone container on an EC2 ASG. The image is pulled
from a Terraform-managed ECR repository; `dashboard_image_tag` is part of the launch template
and ASG version pin, so an immutable tag change triggers instance refresh (ADR-011).
`NEXTAUTH_SECRET` is read from SSM at boot.

Known gap: the `UserRoleProvisioner` Lambda (`cc-on-bedrock-user-role-provisioner`) is invoked
by name from `modules/security` but is not defined in Terraform yet, and the EventBridge
pre-provisioning rule + DLQ (ADR-010) are not ported.

## Commands

```bash
# Partial S3 backend (`backend "s3" {}` in providers.tf): pass settings at init (use_lockfile needs Terraform >= 1.10)
terraform -chdir=terraform init \
  -backend-config="bucket=cc-on-bedrock-tfstate-<ACCOUNT_ID>" \
  -backend-config="key=cc-on-bedrock/terraform.tfstate" \
  -backend-config="region=<REGION>" -backend-config="encrypt=true" -backend-config="use_lockfile=true"
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

Fresh dashboard bootstrap is two-phase because Terraform owns the dashboard ECR
repository but Docker image publishing is outside Terraform:

```bash
terraform -chdir=terraform apply -target=module.security.aws_ecr_repository.dashboard
IMAGE_TAG=$(git rev-parse --short HEAD) scripts/05-build-docker-images.sh dashboard
terraform -chdir=terraform apply -var="dashboard_image_tag=$(git rev-parse --short HEAD)"
```

`dashboard_image_tag` is required and must not be `latest`; ASG instance refresh
depends on the launch template tag string changing.

## Migrating a pre-ADR-015 deployment

A state from before ADR-015 (the stack owned its VPC and Route 53 zone, and had internet-facing
LBs) cannot be upgraded in place: the LB scheme, endpoint keys and OTEL NLB security groups all
force replacement. Do a destroy and a fresh apply:
1. Back up the state (`terraform state pull > backup.json`).
2. Run `terraform state rm` on anything that must survive the destroy: the shared public zone
   (`module.network.aws_route53_zone.this`; the `removed` block also covers it) and any ECR
   repositories you want to keep.
3. Run `terraform destroy`. Then, **before** `terraform apply`, re-import the kept ECR
   repositories (`terraform import` or temporary `import` blocks); otherwise the apply fails
   with `RepositoryAlreadyExistsException`. Apply with the new tfvars (`vpc_id` and subnet IDs).
4. Users re-launch their DevEnvs, since running instances keep the old collector DNS name.

## Rules

- Do not add alternate deployment IaC equivalents.
- Lambda packages must read from `../lambda` through the root `local.lambda_src_dir`.
- Keep code-server on `8080`; nginx may route additional validated custom ports.
- Keep EC2 and Local roles distinct, but aligned by shared policy boundary, tags, and inference-profile attribution.
- Ingress reaches origins only through CloudFront: both load balancers are `internal`, reached by CloudFront VPC origins, and admit only the CloudFront VPC-origin SG (ADR-015). Do not add `0.0.0.0/0` / `::/0` ingress or public IPs on compute.
- Two OTel collectors exist with distinct root outputs. `otel_collector_endpoint` is the legacy `ecs-devenv` awsemf collector (container-devenv path); `otel_rollup_collector_endpoint` is the `usage-tracking` rollup collector that EC2 DevEnv instances actually send Claude Code telemetry to. Keep them separate.
- `ec2-devenv`'s `otel_collector_security_group_ids` scopes the restricted and locked tiers' OTLP/HTTP 4318 egress to the two collector NLBs' security groups (no CIDR, since the VPC may be shared). The NLBs admit 4318 only from the three DevEnv SGs (`otel_from_devenv` in the root module).
- Budget increase approvals and role groups (ADR-008 amendment 2026-10-24) add no new tables: grants live on `cc-user-budgets` / `cc-department-budgets` and requests in the approval table. The dashboard Cognito policy (`modules/security/main.tf` `dashboard_cognito`) includes `AdminRemoveUserFromGroup`, `AdminUserGlobalSignOut` and `ListUsersInGroup` so admins can set a user's single role group and revoke the old session.
- ccdash (optional, separate product): root `ccdash_url` (validated: empty or `https://` without a trailing slash; default `""`) flows to `modules/dashboard` `ccdash_url` and the `CCDASH_URL` runtime env. It only shows a sidebar link and collector setup guidance; Terraform deploys nothing for ccdash and sets no telemetry endpoint.
- Codex on Bedrock (ADR-014): root `codex_model_id` (validated `(global|us|eu|apac).openai.gpt-*`) flows to the dashboard `CODEX_MODEL_ID` runtime env and then to DevEnv `/etc/codex/config.toml`. The per-user Bedrock allow-lists and the task permission boundary (`modules/security`, `modules/ec2-devenv`) include `*openai.gpt-*` foundation-model/inference-profile ARNs and `project/default` (Responses API default project); `tests/unit/test_bedrock_iam_codex_parity.py` keeps the TF/Python/TS copies aligned. Do not grant `bedrock-mantle:*`, because it bypasses invocation-log metering, audit and the budget deny. The `cc-bedrock-audit` EventBridge rule matches `Responses` and is account-wide (audit-logger tags non-platform principals `mode=other`).
