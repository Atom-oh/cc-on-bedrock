###############################################################################
# Security Module - Cognito (Hosted UI), ACM, KMS, Secrets Manager, IAM
# Equivalent to cdk/lib/02-security-stack.ts
#
# CDK constructs covered here:
#   - KMS Key (alias/cc-on-bedrock, key rotation)
#   - Cognito User Pool + Hosted UI domain + AppClient (with secret) + CliPublicClient
#   - Cognito custom attributes (subdomain, container_os, resource_tier,
#     security_policy, container_id, department, budget_exceeded,
#     storage_type, dept_manager_sub) — ADR-022
#   - Cognito Groups (admin, user, dept-manager)
#   - DynamoDB cc-department-budgets table
#   - ACM certs: *.<dev>.<domain> (DNS-validated) and <dashboard>.<domain>
#   - Secrets Manager: cloudfront secret (X-Custom-Secret header)
#   - IAM: TaskPermissionBoundary managed policy (ADR-021 wildcard Claude family),
#          EcsInfrastructureRole (EBS volume attach), DashboardEc2Role (composite
#          EC2 + ECS-tasks principals; data-infra + ec2-devenv managed policies)
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id       = data.aws_caller_identity.current.account_id
  region           = data.aws_region.current.name
  dev_domain       = "*.${var.dev_subdomain}.${var.domain_name}"
  dashboard_domain = "${var.dashboard_subdomain}.${var.domain_name}"

  # Mirrors CDK ADR-021 wildcard Claude family (region-prefix agnostic).
  bedrock_resources = [
    "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
    "arn:aws:bedrock:*:${local.account_id}:inference-profile/*anthropic.claude-*",
    "arn:aws:bedrock:*:${local.account_id}:application-inference-profile/*",
  ]
}

# ---- KMS Encryption Key -----------------------------------------------------
resource "aws_kms_key" "this" {
  description         = "CC-on-Bedrock encryption key for EBS, RDS, EFS"
  enable_key_rotation = true
}

resource "aws_kms_alias" "this" {
  name          = "alias/cc-on-bedrock"
  target_key_id = aws_kms_key.this.key_id
}

# ---- Cognito User Pool -------------------------------------------------------
resource "aws_cognito_user_pool" "this" {
  name = "cc-on-bedrock-users"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  # Custom attributes — mirrors cdk/lib/02-security-stack.ts:51-64.
  # ADR-022 added dept_manager_sub (self-pointing for managers, empty for admin).
  dynamic "schema" {
    for_each = toset([
      "subdomain",
      "container_os",
      "resource_tier",
      "security_policy",
      "container_id",
      "department",
      "budget_exceeded",
      "storage_type",
      "dept_manager_sub",
    ])
    content {
      name                = schema.value
      attribute_data_type = "String"
      mutable             = true
      string_attribute_constraints {}
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
}

# Cognito Hosted UI domain — required for OAuth code grant w/ NextAuth.
resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}

# SSR App Client (with secret) — Dashboard's NextAuth provider.
resource "aws_cognito_user_pool_client" "app" {
  name                          = "AppClient"
  user_pool_id                  = aws_cognito_user_pool.this.id
  generate_secret               = true
  prevent_user_existence_errors = "ENABLED"

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

# ADR-014: Public app client for the cc-bedrock-local CLI (USER_PASSWORD_AUTH).
# No secret — access tokens are verified server-side by the Dashboard's
# /api/local/credentials route via cognito-idp:GetUser.
resource "aws_cognito_user_pool_client" "cli_public" {
  name                          = "cc-on-bedrock-cli-public"
  user_pool_id                  = aws_cognito_user_pool.this.id
  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  refresh_token_validity = 30
  access_token_validity  = 1
  id_token_validity      = 1

  token_validity_units {
    refresh_token = "days"
    access_token  = "hours"
    id_token      = "hours"
  }
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
  description  = "Department managers who can approve users and manage department budgets"
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
# DevEnv wildcard (regional ap-northeast-2). The us-east-1 cert used by the
# DevEnv CloudFront distribution is passed in separately via the root
# `devenv_cert_arn` variable (CDK context devEnvCertArn).
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

# Dashboard cert (regional ap-northeast-2 for the ALB). Optional — if the user
# passes in a pre-validated cert via dashboard_cert_arn, skip module-managed
# cert creation. Mirrors CDK context dashboardCertArn.
locals {
  create_dashboard_cert = var.dashboard_cert_arn == ""
}

resource "aws_acm_certificate" "dashboard" {
  count             = local.create_dashboard_cert ? 1 : 0
  domain_name       = local.dashboard_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "cc-on-bedrock-dashboard" }
}

resource "aws_route53_record" "dashboard_cert_validation" {
  for_each = local.create_dashboard_cert ? {
    for dvo in aws_acm_certificate.dashboard[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "dashboard" {
  count                   = local.create_dashboard_cert ? 1 : 0
  certificate_arn         = aws_acm_certificate.dashboard[0].arn
  validation_record_fqdns = [for r in aws_route53_record.dashboard_cert_validation : r.fqdn]
}

# ---- Secrets Manager ---------------------------------------------------------
# CDK uses generateSecretString { excludePunctuation: true, passwordLength: 32 }.
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

# ---- IAM: shared policy document fragments ---------------------------------
data "aws_iam_policy_document" "bedrock_invoke" {
  statement {
    actions = [
      "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse", "bedrock:ConverseStream",
    ]
    resources = local.bedrock_resources
  }
}

# EC2 + ECS-tasks composite assume-role trust — dashboard role can be assumed
# by both the EC2 instance and the dashboard Fargate task (ADR-016).
data "aws_iam_policy_document" "dashboard_role_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com", "ecs-tasks.amazonaws.com"]
    }
  }
}

# ECS service principal — for EcsInfrastructureRole (EBS volume attach).
data "aws_iam_policy_document" "ecs_service_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs.amazonaws.com"]
    }
  }
}

# ---- IAM: Task Permission Boundary (ADR-021) -------------------------------
# Caps the maximum permissions any cc-on-bedrock-task-* role can have. Must be
# at least as permissive as any role's inline policy, else effective perm = ∅.
data "aws_iam_policy_document" "task_permission_boundary" {
  statement {
    sid       = "BedrockClaude"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
    resources = local.bedrock_resources
  }
  statement {
    sid     = "S3Access"
    actions = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = [
      "arn:aws:s3:::cc-on-bedrock-user-data-${local.account_id}",
      "arn:aws:s3:::cc-on-bedrock-user-data-${local.account_id}/*",
      "arn:aws:s3:::${var.project_prefix}-deploy-${local.account_id}",
      "arn:aws:s3:::${var.project_prefix}-deploy-${local.account_id}/*",
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
    sid       = "CloudWatchLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
    resources = ["arn:aws:logs:*:${local.account_id}:log-group:/cc-on-bedrock/*"]
  }
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = ["arn:aws:ecr:${local.region}:${local.account_id}:repository/cc-on-bedrock/*"]
  }
  statement {
    sid       = "SsmMessages"
    actions   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
    resources = ["*"]
  }
  statement {
    sid       = "SecretsRead"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:*:${local.account_id}:secret:cc-on-bedrock/*"]
  }
  statement {
    sid       = "AgentCoreGateway"
    actions   = ["bedrock-agentcore:InvokeGateway"]
    resources = ["arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:gateway/*"]
  }
  statement {
    sid       = "DynamoDbMcpConfig"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = ["arn:aws:dynamodb:${local.region}:${local.account_id}:table/cc-dept-mcp-config"]
  }
}

resource "aws_iam_policy" "task_permission_boundary" {
  name        = "cc-on-bedrock-task-boundary"
  description = "Permission boundary for per-user cc-on-bedrock-task-* roles (ADR-021)"
  policy      = data.aws_iam_policy_document.task_permission_boundary.json
}

# ---- IAM: ECS Infrastructure Role (EBS volume attach to tasks) ------------
resource "aws_iam_role" "ecs_infrastructure" {
  name               = "cc-on-bedrock-ecs-infrastructure"
  assume_role_policy = data.aws_iam_policy_document.ecs_service_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_infrastructure_volumes" {
  role       = aws_iam_role.ecs_infrastructure.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRolePolicyForVolumes"
}

# ECS needs CreateGrant to delegate KMS access to EC2 for EBS attach.
data "aws_iam_policy_document" "ecs_infra_kms" {
  statement {
    sid       = "KmsCreateGrantForEbs"
    actions   = ["kms:CreateGrant", "kms:DescribeKey", "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:ReEncryptFrom", "kms:ReEncryptTo"]
    resources = [aws_kms_key.this.arn]
    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "ecs_infrastructure_kms" {
  role   = aws_iam_role.ecs_infrastructure.id
  name   = "ebs-kms"
  policy = data.aws_iam_policy_document.ecs_infra_kms.json
}

# ---- IAM: Dashboard Role (composite EC2 + ECS-tasks) ----------------------
resource "aws_iam_role" "dashboard_ec2" {
  name               = "cc-on-bedrock-dashboard-ec2"
  assume_role_policy = data.aws_iam_policy_document.dashboard_role_assume.json
}

resource "aws_iam_role_policy_attachment" "dashboard_ssm" {
  role       = aws_iam_role.dashboard_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Bedrock invoke (Dashboard runs local model preview calls).
resource "aws_iam_role_policy" "dashboard_bedrock" {
  role   = aws_iam_role.dashboard_ec2.id
  name   = "bedrock-invoke"
  policy = data.aws_iam_policy_document.bedrock_invoke.json
}

# Cognito admin operations.
data "aws_iam_policy_document" "dashboard_cognito" {
  statement {
    actions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminUpdateUserAttributes",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:ListUsers",
      "cognito-idp:DescribeUserPoolClient",
    ]
    resources = [aws_cognito_user_pool.this.arn]
  }
}

resource "aws_iam_role_policy" "dashboard_cognito" {
  role   = aws_iam_role.dashboard_ec2.id
  name   = "cognito-admin"
  policy = data.aws_iam_policy_document.dashboard_cognito.json
}

# ECS task control + PassRole for cc-on-bedrock-ecs-task / -execution / -task-*.
data "aws_iam_policy_document" "dashboard_ecs" {
  statement {
    actions   = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks", "ecs:TagResource", "ecs:ExecuteCommand"]
    resources = ["*"]
  }
  statement {
    sid       = "EfsAccess"
    actions   = ["elasticfilesystem:DescribeFileSystems"]
    resources = ["arn:aws:elasticfilesystem:${local.region}:${local.account_id}:file-system/*"]
  }
  statement {
    sid = "AlbManagement"
    actions = [
      "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DeleteTargetGroup",
      "elasticloadbalancing:RegisterTargets", "elasticloadbalancing:DeregisterTargets",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:CreateRule", "elasticloadbalancing:DeleteRule",
      "elasticloadbalancing:DescribeRules",
    ]
    resources = ["arn:aws:elasticloadbalancing:${local.region}:${local.account_id}:*"]
  }
  statement {
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${local.account_id}:role/cc-on-bedrock-ecs-task",
      "arn:aws:iam::${local.account_id}:role/cc-on-bedrock-ecs-task-execution",
      "arn:aws:iam::${local.account_id}:role/cc-on-bedrock-task-*",
      "arn:aws:iam::${local.account_id}:role/cc-on-bedrock-ecs-infrastructure",
    ]
  }
}

resource "aws_iam_role_policy" "dashboard_ecs" {
  role   = aws_iam_role.dashboard_ec2.id
  name   = "ecs-manage"
  policy = data.aws_iam_policy_document.dashboard_ecs.json
}

# Data + infra (separate managed policy to avoid 10KB inline limit).
data "aws_iam_policy_document" "dashboard_data_infra" {
  statement {
    sid       = "IamTaskRoleManagement"
    actions   = ["iam:CreateRole", "iam:GetRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:TagRole", "iam:DeleteRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/cc-on-bedrock-task-*"]
  }
  statement {
    sid       = "SecretsManagerCodeserver"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:cc-on-bedrock/codeserver/*"]
  }
  statement {
    sid     = "DynamoDBAccess"
    actions = ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchGetItem"]
    resources = [
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.project_prefix}-usage",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.project_prefix}-usage/*",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/cc-department-budgets",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/cc-on-bedrock-approval-requests",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/cc-user-budgets",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.project_prefix}-limits",
    ]
  }
  statement {
    sid       = "IamLocalUserRoleReset"
    actions   = ["iam:DeleteRolePolicy", "iam:GetRolePolicy"]
    resources = ["arn:aws:iam::${local.account_id}:role/cc-on-bedrock-local-user-*"]
  }
  statement {
    sid       = "RoutingTableAccess"
    actions   = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = ["arn:aws:dynamodb:${local.region}:${local.account_id}:table/cc-routing-table"]
  }
  statement {
    sid       = "EcsTaskDefRegistration"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:DescribeClusters"]
    resources = ["*"]
  }
  statement {
    sid       = "LambdaInvoke"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${local.region}:${local.account_id}:function:cc-on-bedrock-*"]
  }
  statement {
    sid       = "KmsDecrypt"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.this.arn]
  }
}

resource "aws_iam_policy" "dashboard_data_infra" {
  name   = "cc-on-bedrock-dashboard-data-infra"
  policy = data.aws_iam_policy_document.dashboard_data_infra.json
}

resource "aws_iam_role_policy_attachment" "dashboard_data_infra" {
  role       = aws_iam_role.dashboard_ec2.name
  policy_arn = aws_iam_policy.dashboard_data_infra.arn
}

# EC2-per-user DevEnv management (separate managed policy).
data "aws_iam_policy_document" "dashboard_ec2_devenv" {
  statement {
    sid = "Ec2DevenvInstances"
    actions = [
      "ec2:RunInstances", "ec2:StartInstances", "ec2:StopInstances",
      "ec2:TerminateInstances", "ec2:DescribeInstances", "ec2:CreateTags",
      "ec2:ModifyInstanceAttribute", "ec2:ModifyNetworkInterfaceAttribute",
      "ec2:ModifyVolume", "ec2:DescribeVolumes",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "Ec2DevenvDynamoDB"
    actions   = ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = ["arn:aws:dynamodb:${local.region}:${local.account_id}:table/cc-user-instances"]
  }
  statement {
    sid       = "Ec2DevenvIamRoles"
    actions   = ["iam:CreateRole", "iam:GetRole", "iam:PutRolePolicy", "iam:TagRole", "iam:DeleteRole", "iam:DeleteRolePolicy"]
    resources = ["arn:aws:iam::${local.account_id}:role/cc-on-bedrock-task-*"]
  }
  statement {
    sid       = "Ec2DevenvInstanceProfiles"
    actions   = ["iam:CreateInstanceProfile", "iam:GetInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile"]
    resources = ["arn:aws:iam::${local.account_id}:instance-profile/cc-on-bedrock-task-*"]
  }
  statement {
    sid     = "Ec2DevenvPassRole"
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${local.account_id}:role/cc-on-bedrock-task-*",
      "arn:aws:iam::${local.account_id}:role/cc-on-bedrock-devenv-instance",
    ]
  }
}

resource "aws_iam_policy" "dashboard_ec2_devenv" {
  name   = "cc-on-bedrock-dashboard-ec2-devenv"
  policy = data.aws_iam_policy_document.dashboard_ec2_devenv.json
}

resource "aws_iam_role_policy_attachment" "dashboard_ec2_devenv" {
  role       = aws_iam_role.dashboard_ec2.name
  policy_arn = aws_iam_policy.dashboard_ec2_devenv.arn
}

resource "aws_iam_instance_profile" "dashboard_ec2" {
  name = "cc-on-bedrock-dashboard-ec2"
  role = aws_iam_role.dashboard_ec2.name
}
