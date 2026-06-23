###############################################################################
# Security Module - Cognito, ACM, KMS, Secrets Manager, IAM
###############################################################################

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

# ---- Cognito User Pool -------------------------------------------------------
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
  name         = "AppClient"
  user_pool_id = aws_cognito_user_pool.this.id

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
  user_pool_id = aws_cognito_user_pool.this.id

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

# Cognito Groups
resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Dashboard administrators"
}

resource "aws_cognito_user_group" "user" {
  name         = "user"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Dev environment users"
}

resource "aws_cognito_user_group" "dept_manager" {
  name         = "dept-manager"
  user_pool_id = aws_cognito_user_pool.this.id
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
  domain_name       = local.dev_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "cc-on-bedrock-devenv" }
}

resource "aws_route53_record" "devenv_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.devenv.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "devenv" {
  certificate_arn         = aws_acm_certificate.devenv.arn
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
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300
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
# Per-model spend control is delegated to runtime enforcers (ADR-014 token limits, ADR-015 dollar budget).
data "aws_iam_policy_document" "bedrock" {
  statement {
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic.claude-*",
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
      "arn:aws:bedrock:*::foundation-model/*embed*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*embed*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
    ]
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
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminUpdateUserAttributes",
      "cognito-idp:DescribeUserPoolClient",
      "cognito-idp:ListGroups",
      "cognito-idp:ListUsers",
    ]
    resources = [aws_cognito_user_pool.this.arn]
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
  name   = "ecs-manage"
  role   = aws_iam_role.dashboard_ec2.id
  policy = data.aws_iam_policy_document.dashboard_ecs.json
}

data "aws_iam_policy_document" "dashboard_ec2_devenv" {
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
  name   = "dashboard-ec2-devenv"
  role   = aws_iam_role.dashboard_ec2.id
  policy = data.aws_iam_policy_document.dashboard_ec2_devenv.json
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
