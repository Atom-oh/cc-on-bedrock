###############################################################################
# Security Module - Cognito, ACM, KMS, Secrets Manager, IAM
# Equivalent to cdk/lib/02-security-stack.ts
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  dev_domain       = "*.${var.dev_subdomain}.${var.domain_name}"
  dashboard_domain = "dashboard.${var.domain_name}"
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
    name                = "litellm_api_key"
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

  # Sign-in aliases
  username_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
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

  callback_urls = ["https://dashboard.${var.domain_name}/api/auth/callback/cognito"]
  logout_urls   = ["https://dashboard.${var.domain_name}"]
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
resource "random_password" "litellm_master_key" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "litellm_master_key" {
  name = "cc-on-bedrock/litellm-master-key"
}

resource "aws_secretsmanager_secret_version" "litellm_master_key" {
  secret_id     = aws_secretsmanager_secret.litellm_master_key.id
  secret_string = random_password.litellm_master_key.result
}

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

resource "random_password" "valkey_auth" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "valkey_auth" {
  name = "cc-on-bedrock/valkey-auth"
}

resource "aws_secretsmanager_secret_version" "valkey_auth" {
  secret_id     = aws_secretsmanager_secret.valkey_auth.id
  secret_string = random_password.valkey_auth.result
}

# ---- IAM Roles ---------------------------------------------------------------

# Bedrock policy document (shared)
data "aws_iam_policy_document" "bedrock" {
  statement {
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic.claude-*",
    ]
  }
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

# ---- LiteLLM EC2 Role -------------------------------------------------------
resource "aws_iam_role" "litellm_ec2" {
  name               = "cc-on-bedrock-litellm-ec2"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "litellm_ssm" {
  role       = aws_iam_role.litellm_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "litellm_ecr" {
  role       = aws_iam_role.litellm_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy" "litellm_bedrock" {
  name   = "bedrock-invoke"
  role   = aws_iam_role.litellm_ec2.id
  policy = data.aws_iam_policy_document.bedrock.json
}

data "aws_iam_policy_document" "litellm_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:cc-on-bedrock/*"]
  }
}

resource "aws_iam_role_policy" "litellm_secrets" {
  name   = "secrets-access"
  role   = aws_iam_role.litellm_ec2.id
  policy = data.aws_iam_policy_document.litellm_secrets.json
}

resource "aws_iam_instance_profile" "litellm_ec2" {
  name = "cc-on-bedrock-litellm-ec2"
  role = aws_iam_role.litellm_ec2.name
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
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminUpdateUserAttributes",
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

resource "aws_iam_instance_profile" "dashboard_ec2" {
  name = "cc-on-bedrock-dashboard-ec2"
  role = aws_iam_role.dashboard_ec2.name
}
