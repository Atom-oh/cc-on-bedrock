###############################################################################
# Security Module - Cognito, ACM, KMS, Secrets Manager, IAM
###############################################################################

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  dev_domain       = "*.${var.dev_subdomain}.${var.domain_name}"
  dashboard_domain = "${var.dashboard_subdomain}.${var.domain_name}"
}

# ---- KMS Encryption Key -----------------------------------------------------
resource "aws_kms_key" "this" {
  description         = "CC-on-Bedrock encryption key for EBS, DynamoDB, and service data"
  enable_key_rotation = true
}

resource "aws_kms_alias" "this" {
  name          = "alias/cc-on-bedrock"
  target_key_id = aws_kms_key.this.key_id
}

# ---- ECR Repository: dashboard image ----------------------------------------
resource "aws_ecr_repository" "dashboard" {
  name                 = "${var.project_prefix}/dashboard"
  image_tag_mutability = "MUTABLE"
  # Dashboard images are rebuildable artifacts. Allow full teardown/redeploy
  # without requiring a manual ECR cleanup step.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.this.arn
  }

  lifecycle {
    # The AWS provider can report KMS encryption drift for existing repositories;
    # keep the repo managed while avoiding noisy replacement of image storage.
    ignore_changes = [encryption_configuration]
  }
}

resource "aws_ecr_lifecycle_policy" "dashboard" {
  repository = aws_ecr_repository.dashboard.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 dashboard images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# ---- Cognito User Pool -------------------------------------------------------
# Shared mode (shared_user_pool_name set): the dashboard, CLI and Lambdas use an
# existing pool owned by another stack, located by name at plan time so no pool ID
# lives in this repo. cc creates only its app clients and prefixed role groups
# there; the pool's schema, triggers and messages belong to the owning stack, which
# must define the custom attributes listed in local.required_custom_attributes.
# The own pool below is kept (unused) in shared mode so clearing the variable is the
# rollback; removing it is a separate cleanup.
locals {
  shared_pool  = var.shared_user_pool_name != ""
  group_prefix = local.shared_pool ? "cc-" : ""
  required_custom_attributes = [
    "subdomain", "container_os", "resource_tier", "security_policy", "container_id",
    "department", "budget_exceeded", "storage_type", "dept_manager_sub",
  ]
  user_pool_id  = local.shared_pool ? data.aws_cognito_user_pool.shared[0].id : aws_cognito_user_pool.this.id
  user_pool_arn = local.shared_pool ? data.aws_cognito_user_pool.shared[0].arn : aws_cognito_user_pool.this.arn
}

data "aws_cognito_user_pools" "shared" {
  count = local.shared_pool ? 1 : 0
  name  = var.shared_user_pool_name

  lifecycle {
    postcondition {
      condition     = length(self.ids) == 1
      error_message = "shared_user_pool_name must match exactly one user pool in this account and region."
    }
  }
}

data "aws_cognito_user_pool" "shared" {
  count        = local.shared_pool ? 1 : 0
  user_pool_id = one(data.aws_cognito_user_pools.shared[0].ids)

  lifecycle {
    postcondition {
      condition = alltrue([
        for a in local.required_custom_attributes :
        contains([for s in self.schema_attributes : s.name], "custom:${a}")
      ])
      error_message = "The shared user pool is missing cc custom attributes; add them in the owning stack first."
    }
    postcondition {
      condition     = self.admin_create_user_config[0].allow_admin_create_user_only
      error_message = "The shared user pool must allow admin-created users only (self sign-up off)."
    }
  }
}

# Every client already in the shared pool must restrict WriteAttributes. Unset means
# a signed-in user can write every mutable attribute, so another app's client would
# let users set their own custom:department or custom:subdomain. cc's own clients
# pass too: they allow `name` only.
data "aws_cognito_user_pool_clients" "shared" {
  count        = local.shared_pool ? 1 : 0
  user_pool_id = local.user_pool_id
}

data "aws_cognito_user_pool_client" "shared" {
  for_each     = local.shared_pool ? toset(data.aws_cognito_user_pool_clients.shared[0].client_ids) : toset([])
  user_pool_id = local.user_pool_id
  client_id    = each.value

  lifecycle {
    postcondition {
      condition = (
        length(self.write_attributes) > 0 &&
        alltrue([for a in self.write_attributes : !startswith(a, "custom:")])
      )
      error_message = "A client in the shared user pool leaves WriteAttributes unset or allows custom:* writes; restrict it in its owning stack first."
    }
  }
}

resource "aws_cognito_user_pool" "this" {
  name = "cc-on-bedrock-users"

  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  schema {
    name                = "subdomain"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  schema {
    name                = "container_os"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  schema {
    name                = "resource_tier"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  schema {
    name                = "security_policy"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  schema {
    name                = "container_id"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  schema {
    name                = "department"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  schema {
    name                = "budget_exceeded"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  schema {
    name                = "storage_type"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  schema {
    name                = "dept_manager_sub"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {}
  }

  # Sign-in aliases
  username_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # ADR-028: JIT-provisioning shim on JIT-creation (POST_CONFIRMATION) and
  # self-heal on every login (POST_AUTHENTICATION). Fail-open in the handler.
  lambda_config {
    post_confirmation   = aws_lambda_function.cognito_provisioner_trigger.arn
    post_authentication = aws_lambda_function.cognito_provisioner_trigger.arn
  }
}

resource "aws_cognito_user_pool_client" "this" {
  # A shared pool hosts other apps' clients, so the name says whose client this is.
  name         = local.shared_pool ? "cc-on-bedrock-dashboard" : "AppClient"
  user_pool_id = local.user_pool_id

  # Users must not self-write custom:* (subdomain names the issued IAM role; department and
  # budget_exceeded drive budgets). Unset means every attribute is writable; admins use Admin* APIs.
  write_attributes = ["name"]

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  supported_identity_providers         = ["COGNITO"]

  callback_urls = ["https://${local.dashboard_domain}/api/auth/callback/cognito"]
  logout_urls   = ["https://${local.dashboard_domain}"]
}

# Public app client for cc-bedrock-local USER_PASSWORD_AUTH.
resource "aws_cognito_user_pool_client" "cli_public" {
  name         = "cc-on-bedrock-cli-public"
  user_pool_id = local.user_pool_id

  # Users must not self-write custom:* (subdomain names the issued IAM role; department and
  # budget_exceeded drive budgets). Unset means every attribute is writable; admins use Admin* APIs.
  write_attributes = ["name"]

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
}

# Cognito Groups. In a shared pool they carry the "cc-" prefix and are the access
# gate: a user in none of them has no cc access (dashboard, CLI credentials).
resource "aws_cognito_user_group" "admin" {
  name         = "${local.group_prefix}admin"
  user_pool_id = local.user_pool_id
  description  = "Dashboard administrators"
}

resource "aws_cognito_user_group" "user" {
  name         = "${local.group_prefix}user"
  user_pool_id = local.user_pool_id
  description  = "Dev environment users"
}

resource "aws_cognito_user_group" "dept_manager" {
  name         = "${local.group_prefix}dept-manager"
  user_pool_id = local.user_pool_id
  description  = "Department managers"
  precedence   = 5
}

# ---- DynamoDB Table for Department Budgets ----------------------------------
resource "aws_dynamodb_table" "department_budgets" {
  name         = "cc-department-budgets"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "dept_id"

  attribute {
    name = "dept_id"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.this.arn
  }

  point_in_time_recovery { enabled = true }
  tags = { Name = "cc-department-budgets" }
}

# ---- ACM Certificates --------------------------------------------------------
resource "aws_acm_certificate" "devenv" {
  count = var.devenv_enabled ? 1 : 0

  provider          = aws.us_east_1 # CloudFront requires us-east-1 certificates
  domain_name       = local.dev_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "cc-on-bedrock-devenv" }
}

resource "aws_route53_record" "devenv_cert_validation" {
  for_each = {
    for dvo in flatten(aws_acm_certificate.devenv[*].domain_validation_options) : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.hosted_zone_id
  # ACM reuses the same validation CNAME for a re-issued cert; take over a leftover record.
  allow_overwrite = true
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
}

resource "aws_acm_certificate_validation" "devenv" {
  count = var.devenv_enabled ? 1 : 0

  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.devenv[0].arn
  validation_record_fqdns = [for r in aws_route53_record.devenv_cert_validation : r.fqdn]
}

resource "aws_acm_certificate" "dashboard" {
  domain_name       = local.dashboard_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "cc-on-bedrock-dashboard" }
}

resource "aws_route53_record" "dashboard_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.dashboard.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.hosted_zone_id
  # ACM reuses the same validation CNAME for a re-issued cert; take over a leftover record.
  allow_overwrite = true
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
}

resource "aws_acm_certificate_validation" "dashboard" {
  certificate_arn         = aws_acm_certificate.dashboard.arn
  validation_record_fqdns = [for r in aws_route53_record.dashboard_cert_validation : r.fqdn]
}

# ---- Secrets Manager ---------------------------------------------------------
resource "random_password" "cloudfront_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "cloudfront_secret" {
  name = "cc-on-bedrock/cloudfront-secret"
}

resource "aws_secretsmanager_secret_version" "cloudfront_secret" {
  secret_id     = aws_secretsmanager_secret.cloudfront_secret.id
  secret_string = random_password.cloudfront_secret.result
}

resource "random_password" "nextauth_secret" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "nextauth_secret" {
  name        = "/cc-on-bedrock/nextauth-secret"
  description = "NextAuth secret shared by the dashboard and DevEnv Lambda@Edge session validator"
  type        = "String"
  value       = random_password.nextauth_secret.result
}

# ---- IAM Roles ---------------------------------------------------------------

# Bedrock policy document (shared)
# ADR-021: wildcard Claude family — covers anthropic./global./us./apac./eu./future region prefixes.
# Per-model spend control is delegated to runtime enforcers (ADR-006 (legacy ADR-014) token limits, ADR-015 dollar budget).
data "aws_iam_policy_document" "bedrock" {
  statement {
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic.claude-*",
      # ADR-014 Codex on Bedrock: OpenAI GPT via bedrock-runtime Responses API, which
      # also authorizes bedrock:InvokeModel on the account default project (project/default).
      "arn:aws:bedrock:*::foundation-model/*openai.gpt-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*openai.gpt-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:project/default",
      "arn:aws:bedrock:*::foundation-model/*embed*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*embed*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
    ]
  }
}

data "aws_iam_policy_document" "task_permission_boundary" {
  statement {
    sid     = "BedrockClaude"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic.claude-*",
      # ADR-014 Codex on Bedrock: OpenAI GPT via bedrock-runtime Responses API, which
      # also authorizes bedrock:InvokeModel on the account default project (project/default).
      "arn:aws:bedrock:*::foundation-model/*openai.gpt-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*openai.gpt-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:project/default",
      "arn:aws:bedrock:*::foundation-model/*embed*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*embed*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
    ]
  }

  # ADR-014 (amended 2026-10-26): ceiling for Codex on bedrock-mantle. Nothing grants it
  # by default — budget-check puts a per-user inline policy (own project only) on the
  # Local role of users whose cost is unlimited, and removes it when any cap appears.
  dynamic "statement" {
    for_each = var.enable_mantle ? [1] : []
    content {
      sid       = "BedrockMantleUnmetered"
      actions   = ["bedrock-mantle:CreateInference", "bedrock-mantle:Get*", "bedrock-mantle:List*"]
      resources = ["arn:aws:bedrock-mantle:us-east-1:${data.aws_caller_identity.current.account_id}:project/*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_mantle ? [1] : []
    content {
      sid       = "BedrockMantleWebSearch"
      actions   = ["bedrock-websearch:InvokeSearch", "bedrock-websearch:InvokeFetch"]
      resources = ["*"]
    }
  }

  statement {
    sid     = "S3Access"
    actions = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = [
      "arn:aws:s3:::cc-on-bedrock-user-data-${data.aws_caller_identity.current.account_id}",
      "arn:aws:s3:::cc-on-bedrock-user-data-${data.aws_caller_identity.current.account_id}/*",
      "arn:aws:s3:::cc-on-bedrock-deploy-${data.aws_caller_identity.current.account_id}",
      "arn:aws:s3:::cc-on-bedrock-deploy-${data.aws_caller_identity.current.account_id}/*",
    ]
  }

  statement {
    sid       = "KmsDecrypt"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this.arn]
  }

  statement {
    sid       = "CloudWatchMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
  }

  statement {
    sid     = "CloudWatchLogs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
    resources = [
      "arn:aws:logs:*:${data.aws_caller_identity.current.account_id}:log-group:/cc-on-bedrock/*",
    ]
  }

  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid     = "EcrPull"
    actions = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [
      "arn:aws:ecr:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:repository/cc-on-bedrock/*",
    ]
  }

  statement {
    sid       = "SsmMessages"
    actions   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
    resources = ["*"]
  }

  statement {
    sid     = "SecretsRead"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:cc-on-bedrock/*",
    ]
  }

  statement {
    sid     = "AgentCoreGateway"
    actions = ["bedrock-agentcore:InvokeGateway"]
    resources = [
      "arn:aws:bedrock-agentcore:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:gateway/*",
    ]
  }

  statement {
    sid       = "DynamoDbMcpConfig"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = ["arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-dept-mcp-config"]
  }

  statement {
    sid       = "AllowInAccount"
    actions   = ["*"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid    = "DenyEscalation"
    effect = "Deny"
    actions = [
      "iam:*", "organizations:*", "account:*",
      "sso:*", "sso-directory:*", "identitystore:*",
      "ram:*",
      "lakeformation:GrantPermissions", "lakeformation:BatchGrantPermissions", "lakeformation:PutDataLakeSettings",
      "sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity",
      "sts:GetFederationToken", "sts:GetSessionToken",
      "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy", "kms:CreateGrant",
      "lambda:AddPermission", "lambda:RemovePermission", "lambda:AddLayerVersionPermission", "lambda:PutFunctionConcurrency",
      "sns:AddPermission", "sns:RemovePermission", "sqs:AddPermission", "sqs:RemovePermission",
      "s3:PutBucketPolicy", "s3:PutBucketAcl", "s3:PutAccountPublicAccessBlock", "s3:DeleteBucketPolicy",
      "dynamodb:PutResourcePolicy", "dynamodb:DeleteResourcePolicy",
      "secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy",
      "ecr:SetRepositoryPolicy", "ecr:PutRegistryPolicy", "ecr:DeleteRegistryPolicy",
      "events:PutPermission", "glue:PutResourcePolicy", "ssm:ModifyDocumentPermission",
      "backup:PutBackupVaultAccessPolicy", "backup:DeleteBackupVaultAccessPolicy",
      "codebuild:UpdateProjectVisibility",
      "logs:PutResourcePolicy", "logs:PutDestinationPolicy", "logs:DeleteResourcePolicy",
      "elasticfilesystem:PutFileSystemPolicy", "elasticfilesystem:DeleteFileSystemPolicy",
      "kinesis:PutResourcePolicy", "kinesis:DeleteResourcePolicy",
      "codeartifact:PutDomainPermissionsPolicy", "codeartifact:PutRepositoryPermissionsPolicy",
      "acm-pca:PutPolicy", "acm-pca:DeletePolicy",
      "eks:CreateAccessEntry", "eks:AssociateAccessPolicy", "eks:UpdateAccessEntry",
      "ec2:ModifySnapshotAttribute", "ec2:ModifyImageAttribute",
      "ec2:ModifySecurityGroupRules", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
    ]
    resources = ["*"]
  }
}

moved {
  from = aws_iam_policy.task_boundary
  to   = aws_iam_policy.task_permission_boundary
}

resource "aws_iam_policy" "task_permission_boundary" {
  name        = "${var.project_prefix}-task-boundary"
  description = "Permission boundary for governed EC2 and Local Bedrock roles"
  policy      = data.aws_iam_policy_document.task_permission_boundary.json
}

# EC2 assume-role trust policy
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# ---- Dashboard EC2 Role -----------------------------------------------------
resource "aws_iam_role" "dashboard_ec2" {
  name               = "cc-on-bedrock-dashboard-ec2"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "dashboard_ssm" {
  role       = aws_iam_role.dashboard_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "dashboard_cognito" {
  statement {
    actions = [
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminUpdateUserAttributes",
      "cognito-idp:AdminUserGlobalSignOut",
      "cognito-idp:DescribeUserPoolClient",
      "cognito-idp:ListGroups",
      "cognito-idp:ListUsers",
      "cognito-idp:ListUsersInGroup",
    ]
    resources = [local.user_pool_arn]
  }
}

resource "aws_iam_role_policy" "dashboard_cognito" {
  name   = "cognito-admin"
  role   = aws_iam_role.dashboard_ec2.id
  policy = data.aws_iam_policy_document.dashboard_cognito.json
}

data "aws_iam_policy_document" "dashboard_data_infra" {
  statement {
    sid = "SsmParameterRead"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = ["arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/cc-on-bedrock/*"]
  }

  statement {
    sid = "BedrockAccess"
    actions = [
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
      "arn:aws:bedrock:*::foundation-model/*embed*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic.claude-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*embed*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
    ]
  }

  statement {
    sid = "AgentCoreAccess"
    actions = [
      "bedrock-agentcore:CreateEvent",
      "bedrock-agentcore:GetAgentRuntime",
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:ListEvents",
      "bedrock-agentcore:StopRuntimeSession",
    ]
    resources = ["*"]
  }

  statement {
    sid = "CloudWatchRead"
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
    ]
    resources = ["*"]
  }

  statement {
    sid = "SecurityDashboardRead"
    actions = [
      "cloudtrail:LookupEvents",
      "ec2:DescribeSecurityGroups",
      "route53resolver:GetFirewallDomainList",
      "route53resolver:GetFirewallRuleGroup",
      "route53resolver:ListFirewallDomainLists",
      "route53resolver:ListFirewallDomains",
      "route53resolver:ListFirewallRuleGroupAssociations",
      "route53resolver:ListFirewallRuleGroups",
      "route53resolver:ListFirewallRules",
    ]
    resources = ["*"]
  }

  statement {
    sid = "DlpDnsFirewallManagement"
    actions = [
      "route53resolver:CreateFirewallDomainList",
      "route53resolver:CreateFirewallRule",
      "route53resolver:DeleteFirewallDomainList",
      "route53resolver:DeleteFirewallRule",
      "route53resolver:UpdateFirewallDomains",
      "route53resolver:UpdateFirewallRule",
    ]
    resources = ["*"]
  }

  statement {
    sid = "SecretsManagerCodeserver"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
    ]
    resources = ["arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:cc-on-bedrock/*"]
  }

  statement {
    sid = "DynamoDBDashboardAccess"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:UpdateItem",
    ]
    resources = [
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-department-budgets",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-dept-mcp-config",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-dlp-domain-lists",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-mcp-catalog",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-on-bedrock-approval-requests",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-on-bedrock-approval-requests/index/*",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-on-bedrock-cli-tokens",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-on-bedrock-cli-tokens/index/*",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-on-bedrock-limits",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-on-bedrock-usage",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-on-bedrock-usage/index/*",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-prompt-audit",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-routing-table",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-user-budgets",
      "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-user-instances",
    ]
  }

  statement {
    sid = "KmsUse"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.this.arn]
  }

  statement {
    sid       = "LambdaInvoke"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:cc-on-bedrock-*"]
  }
}

resource "aws_iam_role_policy" "dashboard_data_infra" {
  name   = "dashboard-data-infra"
  role   = aws_iam_role.dashboard_ec2.id
  policy = data.aws_iam_policy_document.dashboard_data_infra.json
}

data "aws_iam_policy_document" "dashboard_ecs" {
  count = var.devenv_enabled ? 1 : 0

  statement {
    actions   = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks"]
    resources = ["*"]
  }
  statement {
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cc-on-bedrock-ecs-task",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cc-on-bedrock-ecs-task-execution",
    ]
  }
}

resource "aws_iam_role_policy" "dashboard_ecs" {
  count = var.devenv_enabled ? 1 : 0

  name   = "ecs-manage"
  role   = aws_iam_role.dashboard_ec2.id
  policy = data.aws_iam_policy_document.dashboard_ecs[0].json
}

# ECR pull so the dashboard EC2 can run the managed Next.js app image.
data "aws_iam_policy_document" "dashboard_ecr" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.dashboard.arn]
  }
}

resource "aws_iam_role_policy" "dashboard_ecr" {
  name   = "ecr-pull"
  role   = aws_iam_role.dashboard_ec2.id
  policy = data.aws_iam_policy_document.dashboard_ecr.json
}

data "aws_iam_policy_document" "dashboard_ec2_devenv" {
  count = var.devenv_enabled ? 1 : 0

  statement {
    sid = "Ec2DevenvInstances"
    actions = [
      "ec2:CreateSnapshot",
      "ec2:CreateTags",
      "ec2:DeregisterImage",
      "ec2:DescribeImages",
      "ec2:DescribeInstances",
      "ec2:DescribeSnapshots",
      "ec2:DescribeVolumes",
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifyNetworkInterfaceAttribute",
      "ec2:ModifyVolume",
      "ec2:RegisterImage",
      "ec2:RunInstances",
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:TerminateInstances",
    ]
    resources = ["*"]
  }

  statement {
    sid = "Ec2DevenvIamRoles"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:PutRolePolicy",
      "iam:TagRole",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cc-on-bedrock-task-*"]
  }

  statement {
    sid = "Ec2DevenvInstanceProfiles"
    actions = [
      "iam:AddRoleToInstanceProfile",
      "iam:CreateInstanceProfile",
      "iam:GetInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/cc-on-bedrock-task-*"]
  }

  statement {
    sid       = "Ec2DevenvPassRole"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cc-on-bedrock-task-*"]
  }

  statement {
    sid     = "SsmSendRunShellScript"
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/*",
      "arn:aws:ssm:${data.aws_region.current.name}::document/AWS-RunShellScript",
    ]
  }
}

resource "aws_iam_role_policy" "dashboard_ec2_devenv" {
  count = var.devenv_enabled ? 1 : 0

  name   = "dashboard-ec2-devenv"
  role   = aws_iam_role.dashboard_ec2.id
  policy = data.aws_iam_policy_document.dashboard_ec2_devenv[0].json
}

resource "aws_iam_instance_profile" "dashboard_ec2" {
  name = "cc-on-bedrock-dashboard-ec2"
  role = aws_iam_role.dashboard_ec2.name
}

# ---- ADR-028 Cognito provisioner-trigger shim ------------------------------
# Async-invokes the UserRoleProvisioner by static name. The handler is fail-open
# so logins continue if the provisioner is temporarily unavailable.
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "archive_file" "cognito_provisioner_trigger" {
  type        = "zip"
  source_file = "${var.lambda_src_dir}/cognito-provisioner-trigger.py"
  output_path = "${path.module}/.build/cognito-provisioner-trigger.zip"
}

resource "aws_iam_role" "cognito_provisioner_trigger" {
  name               = "cc-on-bedrock-cognito-provisioner-trigger"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "cognito_provisioner_trigger_basic" {
  role       = aws_iam_role.cognito_provisioner_trigger.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "cognito_provisioner_trigger_invoke" {
  name = "invoke-provisioner"
  role = aws_iam_role.cognito_provisioner_trigger.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = ["arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:cc-on-bedrock-user-role-provisioner"]
    }]
  })
}

resource "aws_cloudwatch_log_group" "cognito_provisioner_trigger" {
  name              = "/aws/lambda/cc-on-bedrock-cognito-provisioner-trigger"
  retention_in_days = 30
}

resource "aws_lambda_function" "cognito_provisioner_trigger" {
  function_name    = "cc-on-bedrock-cognito-provisioner-trigger"
  runtime          = "python3.12"
  handler          = "cognito-provisioner-trigger.handler"
  filename         = data.archive_file.cognito_provisioner_trigger.output_path
  source_code_hash = data.archive_file.cognito_provisioner_trigger.output_base64sha256
  role             = aws_iam_role.cognito_provisioner_trigger.arn
  timeout          = 4
  memory_size      = 128
  environment {
    variables = {
      PROVISIONER_FUNCTION_NAME = "cc-on-bedrock-user-role-provisioner"
    }
  }
  depends_on = [aws_cloudwatch_log_group.cognito_provisioner_trigger]
}

resource "aws_lambda_permission" "cognito_invoke_trigger" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cognito_provisioner_trigger.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}
