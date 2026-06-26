###############################################################################
# Usage Tracking Module
# Lambda packaging:
#   We zip each *.py file from <lambda_src_dir> individually via archive_file.
#   This works because every handler in this module is self-contained — the
#   one cross-file dependency in lambda/ (sts-issuer.py importing
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
  # Phase 1 (OTel): DAU/WAU/MAU unique-user-over-window counting.
  attribute {
    name = "gsi_day_pk"
    type = "S"
  }
  attribute {
    name = "gsi_day_sk"
    type = "S"
  }

  global_secondary_index {
    name            = "dept-date-index"
    hash_key        = "PK"
    range_key       = "date"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "day-user-index"
    hash_key        = "gsi_day_pk"
    range_key       = "gsi_day_sk"
    projection_type = "KEYS_ONLY"
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

  # Usage history is retained so
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
# Lambda packaging — per-file archive_file from repo lambda/
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
  # DynamoDB writes (PutItem / UpdateItem / BatchWriteItem) target only the
  # base table — GSIs are write-projected automatically and the IAM service
  # rejects write actions scoped to /index/* as a no-op.
  statement {
    sid       = "UsageTableWrite"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.usage.arn]
  }
  # Reads can target both the base table and any GSI.
  statement {
    sid       = "UsageTableRead"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
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
  # Usage table is read-only — budget-check.py aggregates usage but never
  # writes back to it.
  # Must stay aligned with the token-limit-enforcer and budget-check policies.
  statement {
    sid     = "UsageTableReadOnly"
    actions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
    resources = [
      aws_dynamodb_table.usage.arn,
      "${aws_dynamodb_table.usage.arn}/index/*",
    ]
  }
  # Budget tables are read-write — budget-check.py records computed totals
  # and the active limit row.
  statement {
    sid     = "BudgetTablesReadWrite"
    actions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [
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
  # Usage table is read-only — ec2-idle-stop.py queries usage to determine
  # idleness but never mutates the table.
  # Must stay aligned with the token-limit-enforcer and limit-reset policies.
  statement {
    sid     = "UsageTableReadOnly"
    actions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
    resources = [
      aws_dynamodb_table.usage.arn,
      "${aws_dynamodb_table.usage.arn}/index/*",
    ]
  }
  statement {
    sid       = "DynamoDbKmsDecrypt"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
  # Instance + routing tables are read-write — stop/start updates state rows
  # and the routing table is rewritten when an instance is removed.
  statement {
    sid     = "InstanceAndRoutingTablesReadWrite"
    actions = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.instance_table_name}",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.routing_table_name}",
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
      INSTANCE_TABLE         = var.instance_table_name
      ROUTING_TABLE          = var.routing_table_name
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
# Bedrock invocation logging — IAM role for Bedrock service + provider resource
# ──────────────────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "bedrock_logging_assume" {
  # Confused-deputy guard: only Bedrock principals running in THIS account
  # under THIS region's Bedrock service surface may assume the role. Without
  # these conditions any Bedrock-enabled account could theoretically be made
  # to invoke our role through cross-account API manipulation.
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock:${local.region}:${local.account_id}:*"]
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

# Enable Bedrock invocation logging via the first-class provider resource
# (AWS provider v5.x). Replaces an earlier `null_resource` + `local-exec`
# fallback: the proper resource keeps `terraform plan` drift detection alive
# — if someone toggles logging in the console the next plan re-reconciles.
#
# Text/image/embedding payload capture stays OFF (textDataDeliveryEnabled = false cuts CloudWatch Logs
# cost ~99% — only invocation metadata is recorded).
resource "aws_bedrock_model_invocation_logging_configuration" "this" {
  logging_config {
    embedding_data_delivery_enabled = false
    image_data_delivery_enabled     = false
    text_data_delivery_enabled      = false

    cloudwatch_config {
      log_group_name = aws_cloudwatch_log_group.bedrock_invocation.name
      role_arn       = aws_iam_role.bedrock_logging.arn
    }
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

# ════════════════════════════════════════════════════════════════════════════
# Phase 1 — OTel productivity monitoring pipeline (ported from CDK Stack 03)
# ════════════════════════════════════════════════════════════════════════════

# ---- S3 buffer for raw OTLP batches (collector writes; rollup Lambda reads) --
resource "aws_s3_bucket" "otel_raw" {
  bucket = "cc-on-bedrock-otel-metrics-raw-${local.account_id}"
  lifecycle {
    prevent_destroy = true
  }
  tags = { Name = "cc-on-bedrock-otel-metrics-raw" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "otel_raw" {
  bucket = aws_s3_bucket.otel_raw.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "otel_raw" {
  bucket                  = aws_s3_bucket.otel_raw.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "otel_raw_ssl" {
  bucket = aws_s3_bucket.otel_raw.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.otel_raw.arn, "${aws_s3_bucket.otel_raw.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "otel_raw" {
  bucket = aws_s3_bucket.otel_raw.id
  rule {
    id     = "expire-raw-batches"
    status = "Enabled"
    filter { prefix = "otlp-metrics/" }
    expiration { days = 30 }
  }
}

# ---- otel-metrics-rollup Lambda (multi-source: imports otel_rollup.py) -------
data "archive_file" "otel_rollup" {
  type        = "zip"
  output_path = "${path.module}/.build/otel-metrics-rollup.zip"
  source {
    content  = file("${var.lambda_src_dir}/otel-metrics-rollup.py")
    filename = "otel-metrics-rollup.py"
  }
  source {
    content  = file("${var.lambda_src_dir}/otel_rollup.py")
    filename = "otel_rollup.py"
  }
}

resource "aws_iam_role" "otel_rollup" {
  name               = "cc-on-bedrock-otel-metrics-rollup"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "otel_rollup_basic" {
  role       = aws_iam_role.otel_rollup.name
  policy_arn = local.lambda_basic_managed_policy
}

resource "aws_iam_role_policy" "otel_rollup" {
  name = "rollup"
  role = aws_iam_role.otel_rollup.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "UsageTableRW"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems"]
        Resource = [aws_dynamodb_table.usage.arn, "${aws_dynamodb_table.usage.arn}/index/*"]
      },
      {
        Sid      = "RawBucketRead"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.otel_raw.arn, "${aws_s3_bucket.otel_raw.arn}/*"]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "otel_rollup" {
  name              = "/aws/lambda/cc-on-bedrock-otel-metrics-rollup"
  retention_in_days = 30
}

resource "aws_lambda_function" "otel_rollup" {
  function_name    = "cc-on-bedrock-otel-metrics-rollup"
  runtime          = "python3.12"
  handler          = "otel-metrics-rollup.handler"
  filename         = data.archive_file.otel_rollup.output_path
  source_code_hash = data.archive_file.otel_rollup.output_base64sha256
  role             = aws_iam_role.otel_rollup.arn
  timeout          = 60
  memory_size      = 256
  environment {
    variables = { USAGE_TABLE_NAME = aws_dynamodb_table.usage.name }
  }
  depends_on = [aws_cloudwatch_log_group.otel_rollup]
}

resource "aws_lambda_permission" "otel_rollup_s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.otel_rollup.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.otel_raw.arn
}

resource "aws_s3_bucket_notification" "otel_raw" {
  bucket = aws_s3_bucket.otel_raw.id
  lambda_function {
    lambda_function_arn = aws_lambda_function.otel_rollup.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "otlp-metrics/"
  }
  depends_on = [aws_lambda_permission.otel_rollup_s3]
}

# ---- OTel Collector Fargate service + internal NLB:4317 ---------------------
locals {
  otel_collector_image = "${local.account_id}.dkr.ecr.${local.region}.amazonaws.com/cc-on-bedrock/otel-collector:latest"
}

resource "aws_ecs_cluster" "otel" {
  name = "cc-on-bedrock-otel"
}

resource "aws_security_group" "otel_collector" {
  name        = "cc-on-bedrock-otel-collector"
  description = "OTLP gRPC from VPC devenvs only"
  vpc_id      = var.vpc_id

  ingress {
    description = "OTLP gRPC from VPC devenvs"
    from_port   = 4317
    to_port     = 4317
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "otel" {
  name               = "cc-on-bedrock-otel"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.private_subnet_ids
}

resource "aws_lb_target_group" "otel" {
  name        = "cc-on-bedrock-otel-4317"
  port        = 4317
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id
}

resource "aws_lb_listener" "otel" {
  load_balancer_arn = aws_lb.otel.arn
  port              = 4317
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.otel.arn
  }
}

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "otel_task_exec" {
  name               = "cc-on-bedrock-otel-task-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "otel_task_exec" {
  role       = aws_iam_role.otel_task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "otel_task" {
  name               = "cc-on-bedrock-otel-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy" "otel_task_s3put" {
  name = "s3-put-raw"
  role = aws_iam_role.otel_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "PutRawBatches"
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = ["${aws_s3_bucket.otel_raw.arn}/*"]
    }]
  })
}

resource "aws_cloudwatch_log_group" "otel_collector" {
  name              = "/ecs/cc-on-bedrock-otel-collector"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "otel_collector" {
  family                   = "cc-on-bedrock-otel-collector"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.otel_task_exec.arn
  task_role_arn            = aws_iam_role.otel_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name         = "otel-collector"
    image        = local.otel_collector_image
    essential    = true
    portMappings = [{ containerPort = 4317, protocol = "tcp" }]
    environment = [
      { name = "OTEL_S3_BUCKET", value = aws_s3_bucket.otel_raw.id },
      { name = "AWS_REGION", value = local.region },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.otel_collector.name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "otel"
      }
    }
  }])
}

resource "aws_ecs_service" "otel_collector" {
  name            = "cc-on-bedrock-otel-collector"
  cluster         = aws_ecs_cluster.otel.id
  task_definition = aws_ecs_task_definition.otel_collector.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.otel_collector.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.otel.arn
    container_name   = "otel-collector"
    container_port   = 4317
  }

  depends_on = [aws_lb_listener.otel]
}

resource "aws_appautoscaling_target" "otel_collector" {
  max_capacity       = 6
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.otel.name}/${aws_ecs_service.otel_collector.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "otel_collector_cpu" {
  name               = "CollectorCpuScaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.otel_collector.resource_id
  scalable_dimension = aws_appautoscaling_target.otel_collector.scalable_dimension
  service_namespace  = aws_appautoscaling_target.otel_collector.service_namespace
  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = 60
  }
}
