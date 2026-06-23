# Migration Plan: CDK → Terraform full parity (ADR-033)

**ADR:** [ADR-033](../../decisions/ADR-033-cdk-to-terraform-migration.md) · **Date:** 2026-06-19
**Sequencing:** parity-first → CDK teardown → terraform apply (destroy is irreversible; only after TF validates).
**Lambda note:** TF packages from `cdk/lib/lambda/*.py` via `archive_file` (`var.lambda_src_dir`) → Lambda LOGIC already flows to TF; only infra WIRING is ported.

## Phase 1 — TF parity build (no destroy; `terraform validate` per module)

### P1.1 root `main.tf` — wire 3 orphan modules
- `module "usage_tracking"` → pass `vpc_id`, `vpc_cidr`, `private_subnet_ids`, `kms_key_arn/id`, `user_pool_id/arn`, `department_budgets_table_name`, `lambda_src_dir`, `domain_name`.
- `module "local_governance"` → STS issuer, limits table, enforcer, reset (ADR-014).
- `module "waf"` → CLOUDFRONT WebACL (us-east-1 provider alias).
- Pass `otel_collector_endpoint = module.usage_tracking.otel_collector_endpoint` to `module.dashboard`.

### P1.2 usage-tracking module (OTel pipeline — all net-new)
- **day-user GSI** on `aws_dynamodb_table.usage`: `day-user-index`, hash `gsi_day_pk`, range `gsi_day_sk`, KEYS_ONLY + 2 `attribute{}` blocks.
- **S3 `otel-metrics-raw`**: `cc-on-bedrock-otel-metrics-raw-${account_id}`, KMS SSE (`var.kms_key_arn`), public-access-block all, SSL-enforce bucket policy, 30-day expiry lifecycle, `prevent_destroy=true`.
- **otel-metrics-rollup Lambda**: MULTI-SOURCE archive (bundle `otel-metrics-rollup.py` + `otel_rollup.py`); role + assume + basic-exec; IAM: usage table RW (+`/index/*`) + raw bucket `s3:GetObject`; log group `/aws/lambda/cc-on-bedrock-otel-metrics-rollup` retention 30; fn `cc-on-bedrock-otel-metrics-rollup`, handler `otel-metrics-rollup.handler`, py3.12, timeout 60, mem 256, env `USAGE_TABLE_NAME`.
- **S3 notification**: raw bucket → rollup Lambda, `s3:ObjectCreated:*`, `filter_prefix=otlp-metrics/`, no suffix; `aws_lambda_permission` for s3.
- **OTel collector Fargate**: ECR ref `cc-on-bedrock/otel-collector`; task def FARGATE awsvpc cpu256/mem512 ARM64, container port 4317, env `OTEL_S3_BUCKET`/`AWS_REGION`; task role `s3:PutObject` raw bucket only; exec role ECR+logs; internal `aws_lb` (network), TG ip:4317 TCP, listener 4317 TCP; `aws_ecs_service` desired 2 + LB block + SG; SG ingress TCP 4317 from `var.vpc_cidr` only, egress all; appautoscaling min2/max6 CPU 60%; output `otel_collector_endpoint = "${nlb.dns_name}:4317"`.
- new vars: `vpc_id`, `vpc_cidr`, `private_subnet_ids`, `lambda_src_dir`.

### P1.3 security module
- **ADR-032 data-volume IAM** on dashboard EC2 role (port parent `DashboardEc2DevenvPolicy`/`DashboardDataInfraPolicy` first): `Ec2DevenvInstances`(+`ec2:DescribeSubnets`, ModifyVolume moved out of `*`); `Ec2DataVolumeCreate`(RequestTag cc:project); `Ec2DataVolumeManage`(Attach/Detach/Modify, ResourceTag cc:project on volume+instance); `Ec2DataVolumeDelete`(DeleteVolume, cc:role=data AND cc:project); `Ec2DataVolumeSsmDocument`(AWS-RunShellScript, no cond); `Ec2DataVolumeSsmTargets`(instance/*, ssm:resourceTag cc:project). + `cc-dept-mcp-config` DynamoDB access.
- **cognito-provisioner-trigger** Lambda (ADR-028): `lambda_src_dir` var, single-file archive, role+invoke perm on `cc-on-bedrock-user-role-provisioner`, fn timeout4/mem128 env `PROVISIONER_FUNCTION_NAME`, lambda_permission cognito-idp, pool `lambda_config` POST_CONFIRMATION/POST_AUTHENTICATION.
- **UserRoleProvisioner + EventBridge + DLQ** (ADR-022) — currently missing.

### P1.4 ecs-devenv module
- **nginx-config-gen Lambda** (ADR-027, currently absent): env `VPC_CIDR`, `INSTANCE_TABLE=cc-user-instances`; IAM `dynamodb:UpdateItem` on cc-user-instances; DDB-stream→S3 wiring.
- DLP SG ingress TCP `1024-65535` from Nginx SG (ASCII desc); reconcile duplicate/deprecated DLP SG set vs ec2-devenv (정본).

### P1.5 dashboard module
- `otel_collector_endpoint` var (default "") → export `OTEL_COLLECTOR_ENDPOINT` in the base64 `user_data` heredoc (empty = telemetry off).

### P1.6 network + cross-cutting
- Route 53 Resolver **DNS Firewall** (DLP DNS layer).
- ADR-016 **CloudFront split** (Dashboard CF + DevEnv CF; `*.dev.<domain>` us-east-1 ACM).
- `governanceOnly` 동등 변수 (skip ecs/ec2 devenv).
- `terraform fmt -recursive` + `terraform validate`.

## Phase 2 — teardown (after `terraform plan` clean + user GO)
- Empty S3 buckets (deploy, otel-raw, access logs) — `cdk destroy` fails on non-empty.
- `cd cdk && npx cdk destroy --all`.
- Verify orphans removed (Route53 records, ENIs, log groups).

## Phase 3 — rebuild + verify
- `terraform.tfvars` from example (domain, cidrs, cert ARNs, account).
- `cd terraform && terraform init && terraform apply`.
- Post: Cognito admin user + SSM cognito params; `scripts/create-ecr-repos.sh` + `docker build.sh all all` + otel-collector image; `scripts/build-ami.sh ubuntu` + SSM ami-id; `scripts/verify-deployment.sh <domain>`.
- ADR-032 Phase B verify on the fresh TF env (born-attached / reattach / resize).
- ADR-033 → Accepted; mark `cdk/` retired.
