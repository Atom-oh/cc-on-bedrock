###############################################################################
# Local Governance Module (ADR-014, ADR-015, ADR-021)
# Equivalent to cdk/lib/08-local-governance-stack.ts
#
# Resources:
#   - cc-on-bedrock-limits DynamoDB table (per-user / per-dept normalized-token state)
#   - STS Issuer Lambda + Function URL (IAM auth)
#   - Token Limit Enforcer Lambda — usage table Stream consumer
#   - Limit Reset Lambda + 3 EventBridge crons (daily/weekly/monthly @ KST)
#   - SNS alert topic
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
}

# ─── SNS alert topic ─────────────────────────────────────────────────────────
resource "aws_sns_topic" "local_gov_alerts" {
  name              = "${var.project_prefix}-local-gov-alerts"
  display_name      = "CC-on-Bedrock Local Governance Alerts"
  kms_master_key_id = var.kms_key_id
}

# ─── Limits DynamoDB table ───────────────────────────────────────────────────
resource "aws_dynamodb_table" "limits" {
  name         = "${var.project_prefix}-limits"
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

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  # CDK applies removalPolicy=RETAIN on this table; mirror that here so a
  # mistaken `terraform destroy` doesn't wipe per-user / per-dept normalized-
  # token state.
  lifecycle {
    prevent_destroy = true
  }
  tags = { Name = "${var.project_prefix}-limits" }
}

# ─── Lambda packaging ────────────────────────────────────────────────────────
#
# sts-issuer.py imports role_factory.py (same directory in cdk/lib/lambda/) so
# the two files must be packaged together — otherwise Lambda init fails with
# ModuleNotFoundError: No module named 'role_factory'. The other handlers
# (token-limit-enforcer.py, limit-reset.py) are self-contained single-file
# modules, so we keep the simple per-file packaging for them.
locals {
  lambda_files = {
    token_limiter = "token-limit-enforcer.py"
    limit_reset   = "limit-reset.py"
  }
}

data "archive_file" "lambda" {
  for_each    = local.lambda_files
  type        = "zip"
  source_file = "${var.lambda_src_dir}/${each.value}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

data "archive_file" "sts_issuer" {
  type        = "zip"
  output_path = "${path.module}/.build/sts_issuer.zip"

  source {
    content  = file("${var.lambda_src_dir}/sts-issuer.py")
    filename = "sts-issuer.py"
  }
  source {
    content  = file("${var.lambda_src_dir}/role_factory.py")
    filename = "role_factory.py"
  }
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  lambda_basic_managed_policy = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ──────────────────────────────────────────────────────────────────────────────
# STS Issuer Lambda + Function URL (IAM auth)
# ADR-021: per-model IAM restriction removed (wildcard Claude family).
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "sts_issuer" {
  name               = "${var.project_prefix}-sts-issuer-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "sts_issuer_basic" {
  role       = aws_iam_role.sts_issuer.name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "sts_issuer_policy" {
  statement {
    sid = "IamPerUserRoleMgmt"
    actions = [
      "iam:CreateRole", "iam:GetRole", "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy", "iam:DeleteRolePolicy",
      "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/${var.project_prefix}-local-user-*"]
  }
  statement {
    sid       = "IamPermissionBoundaryRead"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = [var.task_permission_boundary_arn]
  }
  statement {
    sid       = "StsAssumeRoleIntoLocalUser"
    actions   = ["sts:AssumeRole", "sts:TagSession"]
    resources = ["arn:aws:iam::${local.account_id}:role/${var.project_prefix}-local-user-*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.limits.arn]
  }
}

resource "aws_iam_role_policy" "sts_issuer_policy" {
  role   = aws_iam_role.sts_issuer.id
  name   = "sts-issuer-policy"
  policy = data.aws_iam_policy_document.sts_issuer_policy.json
}

resource "aws_cloudwatch_log_group" "sts_issuer" {
  name              = "/aws/lambda/${var.project_prefix}-sts-issuer"
  retention_in_days = 30
}

resource "aws_lambda_function" "sts_issuer" {
  function_name    = "${var.project_prefix}-sts-issuer"
  role             = aws_iam_role.sts_issuer.arn
  runtime          = "python3.12"
  handler          = "sts-issuer.handler"
  filename         = data.archive_file.sts_issuer.output_path
  source_code_hash = data.archive_file.sts_issuer.output_base64sha256
  # Worst-case path (pre-provisioner miss): AssumeRole + 31s eventual-consistency
  # backoff + ensure_role + DDB lookups. CDK uses 45s
  # (cdk/lib/08-local-governance-stack.ts:111, ADR-022).
  timeout     = 45
  memory_size = 256

  environment {
    variables = {
      ACCOUNT_ID               = local.account_id
      LIMITS_TABLE             = aws_dynamodb_table.limits.name
      PERMISSION_BOUNDARY_NAME = var.task_permission_boundary_name
      ASSUMER_ROLE_ARN         = aws_iam_role.sts_issuer.arn
      # AWS role chaining hard-caps AssumeRole session at 1h regardless of role's
      # MaxSessionDuration. CLI auto-refreshes when remaining < 10min.
      SESSION_DURATION_SECONDS     = "3600"
      MAX_SESSION_DURATION_SECONDS = "3600"
      INFERENCE_PROFILE_PREFIX     = var.project_prefix
    }
  }

  depends_on = [aws_cloudwatch_log_group.sts_issuer]
}

resource "aws_lambda_function_url" "sts_issuer" {
  function_name      = aws_lambda_function.sts_issuer.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "BUFFERED"
}

# ──────────────────────────────────────────────────────────────────────────────
# Token Limit Enforcer — usage-table stream consumer
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "token_limiter" {
  name               = "${var.project_prefix}-token-limit-enforcer-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "token_limiter_basic" {
  role       = aws_iam_role.token_limiter.name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "token_limiter_policy" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.limits.arn]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.local_gov_alerts.arn]
  }
  statement {
    sid       = "IamDenyAttach"
    actions   = ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy"]
    resources = ["arn:aws:iam::${local.account_id}:role/${var.project_prefix}-local-user-*"]
  }
  statement {
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
    resources = [var.usage_table_stream_arn]
  }
}

resource "aws_iam_role_policy" "token_limiter_policy" {
  role   = aws_iam_role.token_limiter.id
  name   = "token-limit-enforcer-policy"
  policy = data.aws_iam_policy_document.token_limiter_policy.json
}

resource "aws_cloudwatch_log_group" "token_limiter" {
  name              = "/aws/lambda/${var.project_prefix}-token-limit-enforcer"
  retention_in_days = 30
}

resource "aws_lambda_function" "token_limiter" {
  function_name    = "${var.project_prefix}-token-limit-enforcer"
  role             = aws_iam_role.token_limiter.arn
  runtime          = "python3.12"
  handler          = "token-limit-enforcer.handler"
  filename         = data.archive_file.lambda["token_limiter"].output_path
  source_code_hash = data.archive_file.lambda["token_limiter"].output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      LIMITS_TABLE       = aws_dynamodb_table.limits.name
      SNS_TOPIC_ARN      = aws_sns_topic.local_gov_alerts.arn
      DENY_POLICY_NAME   = "cc-bedrock-local-token-deny"
      WARNING_THRESHOLDS = "0.8,0.95"
    }
  }

  depends_on = [aws_cloudwatch_log_group.token_limiter]
}

resource "aws_lambda_event_source_mapping" "usage_to_token_limiter" {
  event_source_arn                   = var.usage_table_stream_arn
  function_name                      = aws_lambda_function.token_limiter.arn
  starting_position                  = "LATEST"
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  maximum_retry_attempts             = 3
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]
}

# ──────────────────────────────────────────────────────────────────────────────
# Limit Reset Lambda + 3 EventBridge crons (KST aware)
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "limit_reset" {
  name               = "${var.project_prefix}-limit-reset-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "limit_reset_basic" {
  role       = aws_iam_role.limit_reset.name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "limit_reset_policy" {
  statement {
    actions   = ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.limits.arn]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.local_gov_alerts.arn]
  }
  statement {
    sid       = "IamDenyDetach"
    actions   = ["iam:DeleteRolePolicy", "iam:GetRolePolicy"]
    resources = ["arn:aws:iam::${local.account_id}:role/${var.project_prefix}-local-user-*"]
  }
}

resource "aws_iam_role_policy" "limit_reset_policy" {
  role   = aws_iam_role.limit_reset.id
  name   = "limit-reset-policy"
  policy = data.aws_iam_policy_document.limit_reset_policy.json
}

resource "aws_cloudwatch_log_group" "limit_reset" {
  name              = "/aws/lambda/${var.project_prefix}-limit-reset"
  retention_in_days = 30
}

resource "aws_lambda_function" "limit_reset" {
  function_name    = "${var.project_prefix}-limit-reset"
  role             = aws_iam_role.limit_reset.arn
  runtime          = "python3.12"
  handler          = "limit-reset.handler"
  filename         = data.archive_file.lambda["limit_reset"].output_path
  source_code_hash = data.archive_file.lambda["limit_reset"].output_base64sha256
  timeout          = 300
  memory_size      = 256

  environment {
    variables = {
      LIMITS_TABLE     = aws_dynamodb_table.limits.name
      DENY_POLICY_NAME = "cc-bedrock-local-token-deny"
      SNS_TOPIC_ARN    = aws_sns_topic.local_gov_alerts.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.limit_reset]
}

# daily: 15:00 UTC == 00:00 KST (UTC+9)
resource "aws_cloudwatch_event_rule" "daily_reset" {
  name                = "${var.project_prefix}-limit-reset-daily"
  schedule_expression = "cron(0 15 * * ? *)"
}

resource "aws_cloudwatch_event_target" "daily_reset" {
  rule  = aws_cloudwatch_event_rule.daily_reset.name
  arn   = aws_lambda_function.limit_reset.arn
  input = jsonencode({ period = "daily" })
}

resource "aws_lambda_permission" "daily_reset" {
  statement_id  = "AllowDailyResetSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.limit_reset.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.daily_reset.arn
}

# weekly: every Sunday 15:00 UTC == Monday 00:00 KST
resource "aws_cloudwatch_event_rule" "weekly_reset" {
  name                = "${var.project_prefix}-limit-reset-weekly"
  schedule_expression = "cron(0 15 ? * SUN *)"
}

resource "aws_cloudwatch_event_target" "weekly_reset" {
  rule  = aws_cloudwatch_event_rule.weekly_reset.name
  arn   = aws_lambda_function.limit_reset.arn
  input = jsonencode({ period = "weekly" })
}

resource "aws_lambda_permission" "weekly_reset" {
  statement_id  = "AllowWeeklyResetSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.limit_reset.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.weekly_reset.arn
}

# monthly: last day of month 15:00 UTC == 1st 00:00 KST
resource "aws_cloudwatch_event_rule" "monthly_reset" {
  name                = "${var.project_prefix}-limit-reset-monthly"
  schedule_expression = "cron(0 15 L * ? *)"
}

resource "aws_cloudwatch_event_target" "monthly_reset" {
  rule  = aws_cloudwatch_event_rule.monthly_reset.name
  arn   = aws_lambda_function.limit_reset.arn
  input = jsonencode({ period = "monthly" })
}

resource "aws_lambda_permission" "monthly_reset" {
  statement_id  = "AllowMonthlyResetSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.limit_reset.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.monthly_reset.arn
}
