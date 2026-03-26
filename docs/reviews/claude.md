# Claude Code Architecture Review

> Generated: 2026-03-26 | Phase: initial | Model: Claude Opus 4.6

---

## Summary Table

| ID | Finding | Severity | Category |
|:---|:---|:---|:---|
| 01 | Hardcoded AWS Account ID in 5+ files | **Critical** | Configuration |
| 02 | ALB `0.0.0.0/0:80` + `HTTP_ONLY` origin bypasses CloudFront | **High** | Network Security |
| 03 | `unsafeUnwrap()` exposes secret in CFN template | **High** | Secret Management |
| 04 | No EFS Access Points for user isolation | **High** | Data Isolation |
| 05 | Runtime API unauthenticated when `RUNTIME_API_KEY` unset | **High** | Authentication |
| 06 | Wildcard IAM permissions (`Resource: *`) in 15+ places | **High** | IAM |
| 07 | Hardcoded region `ap-northeast-2` in task definitions | **Medium** | Configuration |
| 08 | DLP "Restricted" allows all HTTPS egress | **Medium** | DLP |
| 09 | ECR repos use MUTABLE tag policy | **Medium** | Supply Chain |
| 10 | Dashboard TF module ALB SG allows `0.0.0.0/0:443` | **Medium** | Network Security |
| 11 | `.gitignore` pattern `*.env` may not catch dotfiles | **Low** | Secret Management |

---

## Findings Detail

### 01. Hardcoded AWS Account ID `061525506239`
- **Severity**: Critical
- **Locations**:
  - `shared/nextjs-app/src/lib/aws-clients.ts:52` - `process.env.AWS_ACCOUNT_ID ?? "061525506239"`
  - `shared/nextjs-app/src/app/api/ai/runtime/route.ts:16` - Full ARN with account ID
  - `cdk/lib/05-dashboard-stack.ts:122` - S3 bucket path in UserData
  - `cdk/cdk.context.json:2` - AZ lookup key
  - `agent/lambda/create_targets.py:18` - Default ACCOUNT_ID
- **Fix**: Use `cdk.Aws.ACCOUNT_ID`, `data.aws_caller_identity`, runtime `sts get-caller-identity`. Add `cdk.context.json` to `.gitignore`.

### 02. ALB Open to `0.0.0.0/0` on Port 80 + HTTP_ONLY Origin
- **Severity**: High
- **Locations**:
  - `cdk/lib/04-ecs-devenv-stack.ts:262` - `albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80))`
  - `cdk/lib/04-ecs-devenv-stack.ts:302` - `protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY`
  - `terraform/modules/ecs-devenv/main.tf:119` - `cidr_blocks = ["0.0.0.0/0"]` port 80
  - `terraform/modules/dashboard/main.tf:27,50` - `cidr_blocks = ["0.0.0.0/0"]` ports 80, 443
  - `cloudformation/04-ecs-devenv.yaml:130` - `CidrIp: '0.0.0.0/0'` port 80
- **Impact**: ALB directly accessible without CloudFront. Traffic unencrypted end-to-end.
- **Fix**: Restrict port 80 to CloudFront prefix list. Use `HTTPS_ONLY` origin protocol.

### 03. `unsafeUnwrap()` Exposes Secret in CloudFormation Template
- **Severity**: High
- **Location**: `cdk/lib/05-dashboard-stack.ts:196` - `cloudfrontSecret.secretValue.unsafeUnwrap()`
- **Impact**: Secret plaintext embedded in synthesized CFN template, visible via `cloudformation:GetTemplate`.
- **Fix**: Use `{{resolve:secretsmanager:...}}` dynamic references.

### 04. No EFS Access Points for User Isolation
- **Severity**: High
- **Locations**:
  - `cdk/lib/04-ecs-devenv-stack.ts:239-246` - `rootDirectory: '/'` with no Access Point
  - `terraform/modules/ecs-devenv/main.tf:348` - No `access_point_id`
  - `cloudformation/04-ecs-devenv.yaml:327-522` - No `AuthorizationConfig` with `AccessPointId`
- **Impact**: All containers share same EFS root. Users can navigate to `/home/coder/users/other-user/`.
- **Fix**: Create per-user EFS Access Points with forced POSIX identities and `rootDirectory`.

### 05. Runtime API Unauthenticated When `RUNTIME_API_KEY` Unset
- **Severity**: High
- **Location**: `shared/nextjs-app/src/app/api/ai/runtime/route.ts:27-33`
- **Impact**: When `RUNTIME_API_KEY` env var is missing, endpoint becomes an unauthenticated proxy to Bedrock AgentCore with hardcoded ARN/URL.
- **Fix**: Require authentication unconditionally. Remove hardcoded ARN/URL fallbacks.

### 06. Wildcard IAM Permissions (`Resource: *`)
- **Severity**: High
- **Locations** (15+ occurrences across 3 IaC tools):

| File | Line | Actions |
|------|------|---------|
| `cdk/lib/04-ecs-devenv-stack.ts` | 71, 147 | `ssmmessages:*`, `bedrock:InvokeModel*` |
| `cdk/lib/05-dashboard-stack.ts` | 41, 52, 57, 70 | `bedrock:*`, `bedrock-agentcore:*`, `cloudwatch:*`, `ec2:Describe*` |
| `cdk/lib/02-security-stack.ts` | 120, 162, 173 | `bedrock:InvokeModel*`, `ecs:*`, `elasticloadbalancing:*` |
| `terraform/modules/security/main.tf` | 235, 323 | `bedrock:InvokeModel*`, `ecs:RunTask/StopTask` |
| `cloudformation/02-security.yaml` | 32, 197, 251 | `kms:*`, `bedrock:InvokeModel*`, `ecs:*` |
| `cloudformation/04-ecs-devenv.yaml` | 66 | `ssmmessages:*` |

- **Note**: ECS Task Role in `04-ecs-devenv-stack.ts:50-65` correctly scopes to `anthropic.claude-*` - this pattern should be applied everywhere.
- **Fix**: Scope Bedrock to `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`. Scope ECS/ELB to cluster/tagged resources.

### 07. Hardcoded Region `ap-northeast-2` in Task Definitions
- **Severity**: Medium
- **Locations**:
  - `cdk/lib/04-ecs-devenv-stack.ts:225-226` - `AWS_DEFAULT_REGION: 'ap-northeast-2'`
  - `terraform/modules/ecs-devenv/main.tf:325` - `value = "ap-northeast-2"`
  - `agent/lambda/cc_dynamodb_mcp.py:12` - `REGION = "ap-northeast-2"`
  - `agent/agent.py:26,32` - `GATEWAY_REGION = "ap-northeast-2"`
  - `docker/litellm/litellm-config.yaml` - 14 occurrences of `aws_region_name: "ap-northeast-2"`
- **Fix**: Use `cdk.Aws.REGION`, `data.aws_region.current.name`, or environment variables.

### 08. DLP "Restricted" Allows All HTTPS Egress
- **Severity**: Medium
- **Location**: `cdk/lib/04-ecs-devenv-stack.ts:117` - `sgRestricted.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443))`
- **Impact**: "Restricted" DLP policy is nearly identical to "open" for HTTPS traffic. Security groups cannot filter by domain.
- **Fix**: Use Route 53 DNS Firewall or AWS Network Firewall for domain-level egress control.

### 09. ECR Repos Use MUTABLE Tag Policy
- **Severity**: Medium
- **Locations**:
  - `terraform/modules/litellm/main.tf:30` - `image_tag_mutability = "MUTABLE"`
  - `terraform/modules/ecs-devenv/main.tf:70` - `image_tag_mutability = "MUTABLE"`
  - `scripts/create-ecr-repos.sh:9-14` - No `--image-tag-mutability IMMUTABLE` flag
- **Fix**: Set `image_tag_mutability = "IMMUTABLE"`. Use git SHA tags instead of `latest`.

### 10. Dashboard TF Module ALB SG Allows `0.0.0.0/0:443`
- **Severity**: Medium
- **Location**: `terraform/modules/dashboard/main.tf:27,50` - `cidr_blocks = ["0.0.0.0/0"]` for ports 80 and 443
- **Note**: CDK and CloudFormation versions correctly use CloudFront prefix list for 443. Terraform is inconsistent.
- **Fix**: Use `data "aws_ec2_managed_prefix_list"` for CloudFront prefix list instead of `0.0.0.0/0`.

### 11. `.gitignore` Pattern Coverage
- **Severity**: Low
- **Location**: `.gitignore` - Uses `*.env` pattern
- **Note**: `*.env` matches `something.env` but verify it catches `.env` (dotfile without extension) and `.env.local`.
- **Fix**: Add explicit `.env` and `.env.*` entries alongside `!.env.example`.
