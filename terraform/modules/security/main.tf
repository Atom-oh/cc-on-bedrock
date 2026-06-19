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
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
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

# ---- ADR-026 Task Permission Boundary --------------------------------------
# Ported from cdk/lib/02-security-stack.ts (TaskPermissionBoundary). The ceiling
# for per-user task/local roles: boundary >= any role inline policy (else effective
# perms = empty), and boundary >= the request-validator service allowlist (T6 CI check).
resource "aws_iam_policy" "task_permission_boundary" {
  name        = "${var.project_prefix}-task-boundary"
  description = "ADR-026 permission boundary ceiling for per-user roles"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "BedrockClaude"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic.claude-*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
        ]
      },
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::cc-on-bedrock-user-data-${data.aws_caller_identity.current.account_id}",
          "arn:aws:s3:::cc-on-bedrock-user-data-${data.aws_caller_identity.current.account_id}/*",
          "arn:aws:s3:::${var.project_prefix}-deploy-${data.aws_caller_identity.current.account_id}",
          "arn:aws:s3:::${var.project_prefix}-deploy-${data.aws_caller_identity.current.account_id}/*",
        ]
      },
      {
        Sid      = "KmsDecrypt"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.this.arn]
      },
      {
        Sid      = "CloudWatchMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = ["*"]
      },
      {
        Sid      = "CloudWatchLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
        Resource = ["arn:aws:logs:*:${data.aws_caller_identity.current.account_id}:log-group:/cc-on-bedrock/*"]
      },
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = ["*"]
      },
      {
        Sid      = "EcrPull"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = ["arn:aws:ecr:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:repository/cc-on-bedrock/*"]
      },
      {
        Sid      = "SsmMessages"
        Effect   = "Allow"
        Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
        Resource = ["*"]
      },
      {
        Sid      = "SecretsRead"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = ["arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:cc-on-bedrock/*"]
      },
      {
        Sid      = "AgentCoreGateway"
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeGateway"]
        Resource = ["arn:aws:bedrock-agentcore:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:gateway/*"]
      },
      {
        Sid      = "DynamoDbMcpConfig"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = ["arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-dept-mcp-config"]
      },
      {
        Sid      = "GrantCeilingSqs"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ChangeMessageVisibility"]
        Resource = ["arn:aws:sqs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
      },
      {
        Sid      = "GrantCeilingSns"
        Effect   = "Allow"
        Action   = ["sns:Publish", "sns:Subscribe", "sns:Unsubscribe", "sns:GetTopicAttributes"]
        Resource = ["arn:aws:sns:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
      },
      {
        Sid    = "GrantCeilingDynamoDb"
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:DescribeTable"]
        Resource = [
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/*",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/*/index/*",
        ]
      },
      {
        Sid      = "GrantCeilingLambda"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction", "lambda:GetFunction"]
        Resource = ["arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:*"]
      },
      {
        Sid      = "GrantCeilingStepFunctions"
        Effect   = "Allow"
        Action   = ["states:StartExecution", "states:StopExecution", "states:DescribeExecution", "states:ListExecutions"]
        Resource = ["arn:aws:states:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
      },
      {
        Sid    = "GrantCeilingEks"
        Effect = "Allow"
        Action = ["eks:DescribeCluster", "eks:ListNodegroups", "eks:DescribeNodegroup"]
        Resource = [
          "arn:aws:eks:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster/*",
          "arn:aws:eks:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:nodegroup/*",
        ]
      },
      {
        Sid    = "GrantCeilingReadOnly"
        Effect = "Allow"
        Action = [
          "eks:ListClusters", "sqs:ListQueues", "sns:ListTopics", "sns:ListSubscriptions",
          "ec2:Describe*", "s3:ListAllMyBuckets", "states:ListStateMachines",
          "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics",
        ]
        Resource = ["*"]
      },
    ]
  })
}

# ---- Dashboard EC2 role: data-infra + EC2 devenv mgmt (ADR-032) -------------
# Ported from cdk/lib/02-security-stack.ts DashboardDataInfraPolicy + DashboardEc2DevenvPolicy.
resource "aws_iam_role_policy" "dashboard_data_infra" {
  name = "data-infra"
  role = aws_iam_role.dashboard_ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "IamTaskRoleManagement"
        Effect   = "Allow"
        Action   = ["iam:CreateRole", "iam:GetRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:TagRole", "iam:DeleteRole"]
        Resource = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cc-on-bedrock-task-*"]
      },
      {
        Sid      = "SecretsManagerCodeserver"
        Effect   = "Allow"
        Action   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:GetSecretValue"]
        Resource = ["arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:cc-on-bedrock/codeserver/*"]
      },
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchGetItem"]
        Resource = [
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${var.project_prefix}-usage",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${var.project_prefix}-usage/*",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-department-budgets",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-on-bedrock-approval-requests",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-user-budgets",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${var.project_prefix}-limits",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-dept-mcp-config",
        ]
      },
      {
        Sid      = "IamLocalUserRoleReset"
        Effect   = "Allow"
        Action   = ["iam:DeleteRolePolicy", "iam:GetRolePolicy"]
        Resource = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cc-on-bedrock-local-user-*"]
      },
      {
        Sid      = "RoutingTableAccess"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = ["arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-routing-table"]
      },
      {
        Sid      = "EcsTaskDefRegistration"
        Effect   = "Allow"
        Action   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:DescribeClusters"]
        Resource = ["*"]
      },
      {
        Sid      = "LambdaInvoke"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = ["arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:cc-on-bedrock-*"]
      },
      {
        Sid      = "KmsDecrypt"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.this.arn]
      },
    ]
  })
}

resource "aws_iam_role_policy" "dashboard_ec2_devenv" {
  name = "ec2-devenv"
  role = aws_iam_role.dashboard_ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Ec2DevenvInstances"
        Effect = "Allow"
        Action = [
          "ec2:RunInstances", "ec2:StartInstances", "ec2:StopInstances",
          "ec2:TerminateInstances", "ec2:DescribeInstances", "ec2:CreateTags",
          "ec2:ModifyInstanceAttribute", "ec2:ModifyNetworkInterfaceAttribute",
          "ec2:DescribeVolumes", "ec2:DescribeSubnets",
        ]
        Resource = ["*"]
      },
      {
        Sid       = "Ec2DataVolumeCreate"
        Effect    = "Allow"
        Action    = ["ec2:CreateVolume"]
        Resource  = ["arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:volume/*"]
        Condition = { StringEquals = { "aws:RequestTag/cc:project" = "cc-on-bedrock" } }
      },
      {
        Sid       = "Ec2DataVolumeManage"
        Effect    = "Allow"
        Action    = ["ec2:AttachVolume", "ec2:DetachVolume", "ec2:ModifyVolume"]
        Resource  = ["arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:volume/*", "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/*"]
        Condition = { StringEquals = { "ec2:ResourceTag/cc:project" = "cc-on-bedrock" } }
      },
      {
        Sid       = "Ec2DataVolumeDelete"
        Effect    = "Allow"
        Action    = ["ec2:DeleteVolume"]
        Resource  = ["arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:volume/*"]
        Condition = { StringEquals = { "ec2:ResourceTag/cc:role" = "data", "ec2:ResourceTag/cc:project" = "cc-on-bedrock" } }
      },
      {
        Sid      = "Ec2DataVolumeSsmDocument"
        Effect   = "Allow"
        Action   = ["ssm:SendCommand"]
        Resource = ["arn:aws:ssm:${data.aws_region.current.name}::document/AWS-RunShellScript"]
      },
      {
        Sid       = "Ec2DataVolumeSsmTargets"
        Effect    = "Allow"
        Action    = ["ssm:SendCommand"]
        Resource  = ["arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/*"]
        Condition = { StringEquals = { "ssm:resourceTag/cc:project" = "cc-on-bedrock" } }
      },
    ]
  })
}
