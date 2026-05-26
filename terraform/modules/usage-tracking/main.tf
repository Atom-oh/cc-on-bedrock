###############################################################################
# Usage Tracking Module
# Equivalent to cdk/lib/03-usage-tracking-stack.ts
#
# Lambda packaging:
#   We zip each *.py file from <lambda_src_dir> individually via archive_file.
#   This works because every handler in this module is self-contained — the
#   one cross-file dependency in cdk/lib/lambda/ (sts-issuer.py importing
#   role_factory.py) lives in the local-governance module, which uses a
#   multi-source archive_file there.
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
}

# ──────────────────────────────────────────────────────────────────────────────
# SNS topic for budget alerts
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_sns_topic" "budget_alerts" {
  name              = "cc-on-bedrock-budget-alerts"
  display_name      = "CC-on-Bedrock Budget Alerts"
  kms_master_key_id = var.kms_key_id
}

# ──────────────────────────────────────────────────────────────────────────────
# DynamoDB: usage table (with Streams, consumed by token-limit-enforcer)
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_dynamodb_table" "usage" {
  name             = "${var.project_prefix}-usage"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "PK"
  range_key        = "SK"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "date"
    type = "S"
  }

  global_secondary_index {
    name            = "dept-date-index"
    hash_key        = "PK"
    range_key       = "date"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  # CDK applies removalPolicy=RETAIN on the usage table; mirror that here so
  # `terraform destroy` cannot wipe historical Bedrock invocation records.
  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.project_prefix}-usage" }
}

# DLP domain lists table (Route 53 DNS Firewall domain management)
resource "aws_dynamodb_table" "dlp_domain_lists" {
  name         = "cc-dlp-domain-lists"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  point_in_time_recovery { enabled = true }

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "cc-dlp-domain-lists" }
}

# ADR-014: CLI bearer tokens (issued by Dashboard, verified by /api/local/credentials)
resource "aws_dynamodb_table" "cli_tokens" {
  name         = "${var.project_prefix}-cli-tokens"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "sub"
    type = "S"
  }
  attribute {
    name = "issuedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "sub-index"
    hash_key        = "sub"
    range_key       = "issuedAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.project_prefix}-cli-tokens" }
}

# Per-user budgets table
resource "aws_dynamodb_table" "user_budgets" {
  name         = "cc-user-budgets"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"

  attribute {
    name = "user_id"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }
  point_in_time_recovery { enabled = true }

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "cc-user-budgets" }
}

# Approval requests
resource "aws_dynamodb_table" "approval_requests" {
  name         = "${var.project_prefix}-approval-requests"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "department"
    type = "S"
  }
  attribute {
    name = "status"
    type = "S"
  }

  global_secondary_index {
    name            = "department-status-index"
    hash_key        = "department"
    range_key       = "status"
    projection_type = "ALL"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }
  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.project_prefix}-approval-requests" }
}

# Audit table
resource "aws_dynamodb_table" "prompt_audit" {
  name         = "cc-prompt-audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"
  range_key    = "timestamp"

  attribute {
    name = "user_id"
    type = "S"
  }
  attribute {
    name = "timestamp"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }
  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "cc-prompt-audit" }
}

# MCP Catalog
resource "aws_dynamodb_table" "mcp_catalog" {
  name         = "cc-mcp-catalog"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }
  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "cc-mcp-catalog" }
}

# Dept MCP config (with Streams -> Gateway Manager)
resource "aws_dynamodb_table" "dept_mcp_config" {
  name             = "cc-dept-mcp-config"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "PK"
  range_key        = "SK"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }
  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "cc-dept-mcp-config" }
}

# ──────────────────────────────────────────────────────────────────────────────
# Lambda packaging — per-file archive_file, src tracked from cdk/lib/lambda
# ──────────────────────────────────────────────────────────────────────────────
locals {
  lambda_files = {
    tracker       = "bedrock-usage-tracker.py"
    budget_check  = "budget-check.py"
    ec2_idle_stop = "ec2-idle-stop.py"
    audit_logger  = "audit-logger.py"
    gateway_mgr   = "gateway-manager.py"
  }
}

data "archive_file" "lambda" {
  for_each    = local.lambda_files
  type        = "zip"
  source_file = "${var.lambda_src_dir}/${each.value}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

# Shared assume-role policy for Lambdas
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Shared basic execution managed policy attachment helper:
# every Lambda gets logs:CreateLogGroup/Stream/PutLogEvents via this attachment.
locals {
  lambda_basic_managed_policy = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ──────────────────────────────────────────────────────────────────────────────
# bedrock-usage-tracker Lambda
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "tracker" {
  name               = "cc-on-bedrock-usage-tracker-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "tracker_basic" {
  role       = aws_iam_role.tracker.name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "tracker_policy" {
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.usage.arn, "${aws_dynamodb_table.usage.arn}/index/*"]
  }
  statement {
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
  statement {
    actions   = ["cognito-idp:ListUsers"]
    resources = [var.user_pool_arn]
  }
  statement {
    actions   = ["iam:GetRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/cc-on-bedrock-local-user-*"]
  }
}

resource "aws_iam_role_policy" "tracker_policy" {
  role   = aws_iam_role.tracker.id
  policy = data.aws_iam_policy_document.tracker_policy.json
  name   = "tracker-policy"
}

resource "aws_cloudwatch_log_group" "tracker" {
  name              = "/aws/lambda/${var.project_prefix}-usage-tracker"
  retention_in_days = 30
}

resource "aws_lambda_function" "tracker" {
  function_name    = "${var.project_prefix}-usage-tracker"
  role             = aws_iam_role.tracker.arn
  runtime          = "python3.12"
  handler          = "bedrock-usage-tracker.handler"
  filename         = data.archive_file.lambda["tracker"].output_path
  source_code_hash = data.archive_file.lambda["tracker"].output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      USAGE_TABLE_NAME     = aws_dynamodb_table.usage.name
      ECS_CLUSTER_NAME     = var.ecs_cluster_name
      COGNITO_USER_POOL_ID = var.user_pool_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.tracker]
}

# EventBridge — CloudTrail Bedrock API calls
resource "aws_cloudwatch_event_rule" "bedrock_api" {
  name        = "cc-on-bedrock-usage-tracking"
  description = "Track Bedrock InvokeModel/Converse API calls for usage analytics"
  event_pattern = jsonencode({
    source        = ["aws.bedrock"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["bedrock.amazonaws.com"]
      eventName = [
        "InvokeModel", "InvokeModelWithResponseStream",
        "Converse", "ConverseStream",
      ]
      userIdentity = {
        sessionContext = {
          sessionIssuer = {
            userName = [
              { prefix = "cc-on-bedrock-task-" },
              { prefix = "cc-on-bedrock-local-user-" },
            ]
          }
        }
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "bedrock_api_to_tracker" {
  rule = aws_cloudwatch_event_rule.bedrock_api.name
  arn  = aws_lambda_function.tracker.arn
}

resource "aws_lambda_permission" "bedrock_api_invoke_tracker" {
  statement_id  = "AllowBedrockApiRule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tracker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.bedrock_api.arn
}

# Bedrock invocation log group + subscription filter → tracker
resource "aws_cloudwatch_log_group" "bedrock_invocation" {
  name              = "/aws/bedrock/invocation-logs"
  retention_in_days = 30
}

resource "aws_lambda_permission" "bedrock_logs_invoke_tracker" {
  statement_id  = "AllowBedrockLogsSubscription"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tracker.function_name
  principal     = "logs.amazonaws.com"
  source_arn    = "${aws_cloudwatch_log_group.bedrock_invocation.arn}:*"
}

resource "aws_cloudwatch_log_subscription_filter" "bedrock_to_tracker" {
  name            = "cc-bedrock-logs-to-usage-tracker"
  log_group_name  = aws_cloudwatch_log_group.bedrock_invocation.name
  filter_pattern  = "{ ($.identity.arn = \"*cc-on-bedrock-task-*\") || ($.identity.arn = \"*cc-on-bedrock-local-user-*\") }"
  destination_arn = aws_lambda_function.tracker.arn
  depends_on      = [aws_lambda_permission.bedrock_logs_invoke_tracker]
}

# ──────────────────────────────────────────────────────────────────────────────
# budget-check Lambda (every 5 min)
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "budget_check" {
  name               = "cc-on-bedrock-budget-check-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "budget_check_basic" {
  role       = aws_iam_role.budget_check.name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "budget_check_policy" {
  statement {
    actions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [
      aws_dynamodb_table.usage.arn,
      "${aws_dynamodb_table.usage.arn}/index/*",
      aws_dynamodb_table.user_budgets.arn,
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.department_budgets_table_name}",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.project_prefix}-limits",
    ]
  }
  statement {
    actions = ["ecs:ListTasks", "ecs:DescribeTasks", "ecs:StopTask"]
    resources = [
      "arn:aws:ecs:${local.region}:${local.account_id}:cluster/${var.ecs_cluster_name}",
      "arn:aws:ecs:${local.region}:${local.account_id}:task/${var.ecs_cluster_name}/*",
    ]
  }
  statement {
    actions   = ["cognito-idp:ListUsers", "cognito-idp:AdminUpdateUserAttributes"]
    resources = [var.user_pool_arn]
  }
  statement {
    actions = ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy"]
    resources = [
      "arn:aws:iam::${local.account_id}:role/cc-on-bedrock-task-*",
      "arn:aws:iam::${local.account_id}:role/cc-on-bedrock-local-user-*",
    ]
  }
  statement {
    actions   = ["iam:ListRoles", "iam:ListRoleTags"]
    resources = ["*"]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.budget_alerts.arn]
  }
}

resource "aws_iam_role_policy" "budget_check_policy" {
  role   = aws_iam_role.budget_check.id
  name   = "budget-check-policy"
  policy = data.aws_iam_policy_document.budget_check_policy.json
}

resource "aws_cloudwatch_log_group" "budget_check" {
  name              = "/aws/lambda/${var.project_prefix}-budget-check"
  retention_in_days = 30
}

resource "aws_lambda_function" "budget_check" {
  function_name    = "${var.project_prefix}-budget-check"
  role             = aws_iam_role.budget_check.arn
  runtime          = "python3.12"
  handler          = "budget-check.handler"
  filename         = data.archive_file.lambda["budget_check"].output_path
  source_code_hash = data.archive_file.lambda["budget_check"].output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      USAGE_TABLE_NAME     = aws_dynamodb_table.usage.name
      DEPT_BUDGETS_TABLE   = var.department_budgets_table_name
      ECS_CLUSTER_NAME     = var.ecs_cluster_name
      DAILY_BUDGET_USD     = tostring(var.daily_budget_usd)
      USER_BUDGETS_TABLE   = aws_dynamodb_table.user_budgets.name
      LIMITS_TABLE         = "${var.project_prefix}-limits"
      SNS_TOPIC_ARN        = aws_sns_topic.budget_alerts.arn
      COGNITO_USER_POOL_ID = var.user_pool_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.budget_check]
}

resource "aws_cloudwatch_event_rule" "budget_check_schedule" {
  name                = "cc-on-bedrock-budget-check-schedule"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "budget_check" {
  rule = aws_cloudwatch_event_rule.budget_check_schedule.name
  arn  = aws_lambda_function.budget_check.arn
}

resource "aws_lambda_permission" "budget_check_invoke" {
  statement_id  = "AllowBudgetCheckSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.budget_check.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.budget_check_schedule.arn
}

# ──────────────────────────────────────────────────────────────────────────────
# ec2-idle-stop Lambda + 3 schedules (idle / EOD shutdown / hibernate expiry)
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "ec2_idle_stop" {
  name               = "cc-on-bedrock-ec2-idle-stop-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "ec2_idle_stop_basic" {
  role       = aws_iam_role.ec2_idle_stop.name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "ec2_idle_stop_policy" {
  statement {
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
  statement {
    actions   = ["ec2:StopInstances", "ec2:StartInstances"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/managed_by"
      values   = ["cc-on-bedrock"]
    }
  }
  statement {
    actions   = ["cloudwatch:GetMetricStatistics", "cloudwatch:GetMetricData"]
    resources = ["*"]
  }
  statement {
    actions = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/cc-user-instances",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/cc-routing-table",
      aws_dynamodb_table.usage.arn,
      "${aws_dynamodb_table.usage.arn}/index/*",
    ]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.budget_alerts.arn]
  }
}

resource "aws_iam_role_policy" "ec2_idle_stop_policy" {
  role   = aws_iam_role.ec2_idle_stop.id
  name   = "ec2-idle-stop-policy"
  policy = data.aws_iam_policy_document.ec2_idle_stop_policy.json
}

resource "aws_cloudwatch_log_group" "ec2_idle_stop" {
  name              = "/aws/lambda/${var.project_prefix}-ec2-idle-stop"
  retention_in_days = 30
}

resource "aws_lambda_function" "ec2_idle_stop" {
  function_name    = "${var.project_prefix}-ec2-idle-stop"
  role             = aws_iam_role.ec2_idle_stop.arn
  runtime          = "python3.12"
  handler          = "ec2-idle-stop.handler"
  filename         = data.archive_file.lambda["ec2_idle_stop"].output_path
  source_code_hash = data.archive_file.lambda["ec2_idle_stop"].output_base64sha256
  timeout          = 300
  memory_size      = 256

  environment {
    variables = {
      REGION                 = local.region
      INSTANCE_TABLE         = "cc-user-instances"
      ROUTING_TABLE          = "cc-routing-table"
      USAGE_TABLE            = aws_dynamodb_table.usage.name
      IDLE_THRESHOLD_MINUTES = "30"
      SNS_TOPIC_ARN          = aws_sns_topic.budget_alerts.arn
      EOD_SHUTDOWN_ENABLED   = "true"
      HIBERNATE_ENABLED      = "true"
    }
  }

  depends_on = [aws_cloudwatch_log_group.ec2_idle_stop]
}

resource "aws_cloudwatch_event_rule" "ec2_idle_check" {
  name                = "cc-ec2-idle-check"
  description         = "Check for idle EC2 devenv instances every 5 minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "ec2_idle_check" {
  rule  = aws_cloudwatch_event_rule.ec2_idle_check.name
  arn   = aws_lambda_function.ec2_idle_stop.arn
  input = jsonencode({ action = "check_idle" })
}

resource "aws_lambda_permission" "ec2_idle_check" {
  statement_id  = "AllowIdleCheck"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ec2_idle_stop.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ec2_idle_check.arn
}

# EOD shutdown — 18:00 KST = 09:00 UTC
resource "aws_cloudwatch_event_rule" "ec2_eod_shutdown" {
  name                = "cc-ec2-eod-shutdown"
  schedule_expression = "cron(0 9 * * ? *)"
}

resource "aws_cloudwatch_event_target" "ec2_eod_shutdown" {
  rule  = aws_cloudwatch_event_rule.ec2_eod_shutdown.name
  arn   = aws_lambda_function.ec2_idle_stop.arn
  input = jsonencode({ action = "schedule_shutdown" })
}

resource "aws_lambda_permission" "ec2_eod_shutdown" {
  statement_id  = "AllowEodShutdown"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ec2_idle_stop.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ec2_eod_shutdown.arn
}

# ADR-010: Hibernate expiry rotation (03:00 UTC daily)
resource "aws_cloudwatch_event_rule" "ec2_hibernate_expiry" {
  name                = "cc-ec2-hibernate-expiry"
  description         = "Rotate hibernated instances approaching AWS 60-day limit"
  schedule_expression = "cron(0 3 * * ? *)"
}

resource "aws_cloudwatch_event_target" "ec2_hibernate_expiry" {
  rule  = aws_cloudwatch_event_rule.ec2_hibernate_expiry.name
  arn   = aws_lambda_function.ec2_idle_stop.arn
  input = jsonencode({ action = "check_hibernate_expiry" })
}

resource "aws_lambda_permission" "ec2_hibernate_expiry" {
  statement_id  = "AllowHibernateExpiry"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ec2_idle_stop.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ec2_hibernate_expiry.arn
}

# ──────────────────────────────────────────────────────────────────────────────
# audit-logger Lambda + EventBridge rule
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "audit_logger" {
  name               = "cc-on-bedrock-audit-logger-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "audit_logger_basic" {
  role       = aws_iam_role.audit_logger.name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "audit_logger_policy" {
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.prompt_audit.arn]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "audit_logger_policy" {
  role   = aws_iam_role.audit_logger.id
  name   = "audit-logger-policy"
  policy = data.aws_iam_policy_document.audit_logger_policy.json
}

resource "aws_cloudwatch_log_group" "audit_logger" {
  name              = "/aws/lambda/${var.project_prefix}-audit-logger"
  retention_in_days = 30
}

resource "aws_lambda_function" "audit_logger" {
  function_name    = "${var.project_prefix}-audit-logger"
  role             = aws_iam_role.audit_logger.arn
  runtime          = "python3.12"
  handler          = "audit-logger.handler"
  filename         = data.archive_file.lambda["audit_logger"].output_path
  source_code_hash = data.archive_file.lambda["audit_logger"].output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      REGION      = local.region
      AUDIT_TABLE = aws_dynamodb_table.prompt_audit.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.audit_logger]
}

resource "aws_cloudwatch_event_rule" "bedrock_audit" {
  name = "cc-bedrock-audit"
  event_pattern = jsonencode({
    source        = ["aws.bedrock"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventName = ["InvokeModel", "InvokeModelWithResponseStream", "Converse", "ConverseStream"]
    }
  })
}

resource "aws_cloudwatch_event_target" "bedrock_audit" {
  rule = aws_cloudwatch_event_rule.bedrock_audit.name
  arn  = aws_lambda_function.audit_logger.arn
}

resource "aws_lambda_permission" "bedrock_audit" {
  statement_id  = "AllowBedrockAudit"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.audit_logger.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.bedrock_audit.arn
}

# ──────────────────────────────────────────────────────────────────────────────
# Bedrock invocation logging — IAM role for Bedrock service + custom enable
# (CDK uses AwsCustomResource; TF leaves a placeholder note. Apply via CLI after
#  terraform apply, see commands below.)
# ──────────────────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "bedrock_logging_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "bedrock_logging" {
  name               = "cc-on-bedrock-invocation-logging"
  assume_role_policy = data.aws_iam_policy_document.bedrock_logging_assume.json
}

data "aws_iam_policy_document" "bedrock_logging_policy" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.bedrock_invocation.arn}:*"]
  }
}

resource "aws_iam_role_policy" "bedrock_logging_policy" {
  role   = aws_iam_role.bedrock_logging.id
  name   = "bedrock-logging"
  policy = data.aws_iam_policy_document.bedrock_logging_policy.json
}

# Enable Bedrock invocation logging — single-shot, idempotent. The
# `put-model-invocation-logging-configuration` API is idempotent on the server
# side, so we re-run on every `terraform apply` to converge any out-of-band
# drift (e.g. someone disabling logging in the console). The `always_run`
# trigger forces re-application on every plan; the other triggers ensure the
# command body changes if the underlying log-group/role identity changes.
resource "null_resource" "enable_bedrock_logging" {
  triggers = {
    always_run    = timestamp()
    role_arn      = aws_iam_role.bedrock_logging.arn
    log_group_arn = aws_cloudwatch_log_group.bedrock_invocation.arn
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws bedrock put-model-invocation-logging-configuration \
        --logging-config 'cloudWatchConfig={logGroupName=${aws_cloudwatch_log_group.bedrock_invocation.name},roleArn=${aws_iam_role.bedrock_logging.arn}},textDataDeliveryEnabled=false,imageDataDeliveryEnabled=false,embeddingDataDeliveryEnabled=false' \
        --region ${local.region}
    EOT
  }

  depends_on = [aws_iam_role_policy.bedrock_logging_policy]
}

# ──────────────────────────────────────────────────────────────────────────────
# Gateway Manager Lambda + DLQ + DDB streams trigger
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_sqs_queue" "gateway_manager_dlq" {
  name                      = "cc-gateway-manager-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_cloudwatch_metric_alarm" "gateway_manager_dlq" {
  alarm_name          = "cc-gateway-manager-dlq-messages"
  alarm_description   = "Gateway Manager Lambda has failed events in DLQ"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = aws_sqs_queue.gateway_manager_dlq.name
  }
}

resource "aws_iam_role" "gateway_manager" {
  name               = "cc-on-bedrock-gateway-manager-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "gateway_manager_basic" {
  role       = aws_iam_role.gateway_manager.name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "gateway_manager_policy" {
  statement {
    actions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [
      aws_dynamodb_table.mcp_catalog.arn,
      aws_dynamodb_table.dept_mcp_config.arn,
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.department_budgets_table_name}",
    ]
  }
  statement {
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
    resources = [aws_dynamodb_table.dept_mcp_config.stream_arn]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.budget_alerts.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.gateway_manager_dlq.arn]
  }
  statement {
    sid = "AgentCoreGatewayManagement"
    actions = [
      "bedrock-agentcore-control:CreateGateway",
      "bedrock-agentcore-control:DeleteGateway",
      "bedrock-agentcore-control:GetGateway",
      "bedrock-agentcore-control:ListGateways",
      "bedrock-agentcore-control:CreateGatewayTarget",
      "bedrock-agentcore-control:DeleteGatewayTarget",
      "bedrock-agentcore-control:GetGatewayTarget",
      "bedrock-agentcore-control:ListGatewayTargets",
      "bedrock-agentcore-control:SynchronizeGatewayTargets",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "IamGatewayRoleManagement"
    actions   = ["iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"]
    resources = ["arn:aws:iam::${local.account_id}:role/cc-on-bedrock-agentcore-gateway-*"]
  }
  statement {
    sid       = "IamPassRoleToAgentCore"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/cc-on-bedrock-agentcore-gateway-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["bedrock-agentcore.amazonaws.com"]
    }
  }
  statement {
    sid       = "LambdaInvoke"
    actions   = ["lambda:GetFunction", "lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${local.region}:${local.account_id}:function:cc-on-bedrock-mcp-*"]
  }
}

resource "aws_iam_role_policy" "gateway_manager_policy" {
  role   = aws_iam_role.gateway_manager.id
  name   = "gateway-manager-policy"
  policy = data.aws_iam_policy_document.gateway_manager_policy.json
}

resource "aws_cloudwatch_log_group" "gateway_manager" {
  name              = "/aws/lambda/${var.project_prefix}-gateway-manager"
  retention_in_days = 30
}

resource "aws_lambda_function" "gateway_manager" {
  function_name    = "${var.project_prefix}-gateway-manager"
  role             = aws_iam_role.gateway_manager.arn
  runtime          = "python3.12"
  handler          = "gateway-manager.lambda_handler"
  filename         = data.archive_file.lambda["gateway_mgr"].output_path
  source_code_hash = data.archive_file.lambda["gateway_mgr"].output_base64sha256
  timeout          = 300
  memory_size      = 256

  environment {
    variables = {
      REGION                   = local.region
      ACCOUNT_ID               = local.account_id
      MCP_CATALOG_TABLE        = aws_dynamodb_table.mcp_catalog.name
      DEPT_MCP_CONFIG_TABLE    = aws_dynamodb_table.dept_mcp_config.name
      DEPT_BUDGETS_TABLE       = var.department_budgets_table_name
      SNS_TOPIC_ARN            = aws_sns_topic.budget_alerts.arn
      PERMISSION_BOUNDARY_NAME = var.task_permission_boundary_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.gateway_manager]
}

resource "aws_lambda_event_source_mapping" "dept_mcp_to_gateway_mgr" {
  event_source_arn  = aws_dynamodb_table.dept_mcp_config.stream_arn
  function_name     = aws_lambda_function.gateway_manager.arn
  starting_position = "TRIM_HORIZON"
  batch_size        = 10

  maximum_batching_window_in_seconds = 5
  maximum_retry_attempts             = 3
  bisect_batch_on_function_error     = false
  function_response_types            = ["ReportBatchItemFailures"]

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.gateway_manager_dlq.arn
    }
  }
}
