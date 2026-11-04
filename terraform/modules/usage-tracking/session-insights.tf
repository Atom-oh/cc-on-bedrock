###############################################################################
# Session insights (gated on var.enable_session_insights)
#   - cc-on-bedrock-sessions: client-reported session buckets (written by the
#     usage tracker's cc.session-report handler, invoked by the dashboard's
#     POST /api/local/sessions) + one INSIGHT#daily row per analyzed UTC date.
#     Insight only: budgets and metering keep using invocation logs (ADR-005).
#   - cc-on-bedrock-session-insights Lambda: daily Haiku analysis of the previous
#     UTC date (aggregate numbers only, users pseudonymized as U1..U10). Its
#     Bedrock calls are not metered: the invocation-log subscription attributes
#     only task/local-user roles.
###############################################################################

locals {
  session_insights_count = var.enable_session_insights ? 1 : 0
  sessions_table_name    = "${var.project_prefix}-sessions"

  # Bedrock ARNs for the insights model. A cross-Region profile id
  # (global./us./eu./apac./...) is invoked through its inference profile in this
  # Region and routed to the foundation model in any destination Region; the
  # foundation-model grant is pinned to that profile with bedrock:InferenceProfileArn.
  insights_fm_id      = replace(var.session_insights_model_id, "/^(global|us|eu|apac|jp|au|ca|us-gov)\\./", "")
  insights_is_profile = local.insights_fm_id != var.session_insights_model_id
  insights_profile_arn = (
    "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/${var.session_insights_model_id}"
  )
}

resource "aws_dynamodb_table" "sessions" {
  count        = local.session_insights_count
  name         = local.sessions_table_name
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
  # Sparse: only session bucket rows carry gsiDate (insight rows do not).
  attribute {
    name = "gsiDate"
    type = "S"
  }

  global_secondary_index {
    name            = "date-index"
    hash_key        = "gsiDate"
    range_key       = "PK"
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

  # No prevent_destroy: rows are client-reported insight data with a 180/400-day
  # TTL, and enable_session_insights = false must be able to remove the table.

  tags = { Name = local.sessions_table_name }
}

# Usage tracker: PutItem session bucket rows (base table only; GSIs are
# write-projected). KMS for this table is covered by tracker_policy's DynamoDbCmk.
resource "aws_iam_role_policy" "tracker_sessions" {
  count = local.session_insights_count
  name  = "tracker-sessions-write"
  role  = aws_iam_role.tracker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SessionsTableWrite"
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem"]
      Resource = aws_dynamodb_table.sessions[0].arn
    }]
  })
}

# ─── session-insights Lambda ────────────────────────────────────────────────
resource "aws_iam_role" "session_insights" {
  count              = local.session_insights_count
  name               = "${var.project_prefix}-session-insights-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "session_insights_basic" {
  count      = local.session_insights_count
  role       = aws_iam_role.session_insights[0].name
  policy_arn = local.lambda_basic_managed_policy
}

data "aws_iam_policy_document" "session_insights" {
  count = local.session_insights_count

  statement {
    sid       = "SessionsRead"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.sessions[0].arn, "${aws_dynamodb_table.sessions[0].arn}/index/date-index"]
  }
  statement {
    sid       = "SessionsInsightWrite"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.sessions[0].arn]
  }
  # Metered (invocation-log) cost per user for the analyzed date: bounded scan of
  # USER# rows, the same approach as budget-check.
  statement {
    sid       = "UsageRead"
    actions   = ["dynamodb:Scan", "dynamodb:Query"]
    resources = [aws_dynamodb_table.usage.arn]
  }
  statement {
    sid       = "DynamoDbCmk"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${local.region}.amazonaws.com"]
    }
  }

  # Only the configured insights model (Converse authorizes as bedrock:InvokeModel).
  dynamic "statement" {
    for_each = local.insights_is_profile ? [1] : []
    content {
      sid       = "InsightsInferenceProfile"
      actions   = ["bedrock:InvokeModel"] # Converse authorizes as InvokeModel
      resources = [local.insights_profile_arn]
    }
  }
  dynamic "statement" {
    for_each = local.insights_is_profile ? [1] : []
    content {
      sid     = "InsightsFoundationModelViaProfile"
      actions = ["bedrock:InvokeModel"] # Converse authorizes as InvokeModel
      resources = [
        "arn:aws:bedrock:*::foundation-model/${local.insights_fm_id}",
        # Global profiles route to Region-less foundation-model ARNs.
        "arn:aws:bedrock:::foundation-model/${local.insights_fm_id}",
      ]
      condition {
        test     = "StringEquals"
        variable = "bedrock:InferenceProfileArn"
        values   = [local.insights_profile_arn]
      }
    }
  }
  dynamic "statement" {
    for_each = local.insights_is_profile ? [] : [1]
    content {
      sid       = "InsightsFoundationModel"
      actions   = ["bedrock:InvokeModel"] # Converse authorizes as InvokeModel
      resources = ["arn:aws:bedrock:${local.region}::foundation-model/${var.session_insights_model_id}"]
    }
  }
}

resource "aws_iam_role_policy" "session_insights" {
  count  = local.session_insights_count
  name   = "session-insights-policy"
  role   = aws_iam_role.session_insights[0].id
  policy = data.aws_iam_policy_document.session_insights[0].json
}

resource "aws_cloudwatch_log_group" "session_insights" {
  count             = local.session_insights_count
  name              = "/aws/lambda/${var.project_prefix}-session-insights"
  retention_in_days = 30
}

resource "aws_lambda_function" "session_insights" {
  count            = local.session_insights_count
  function_name    = "${var.project_prefix}-session-insights"
  role             = aws_iam_role.session_insights[0].arn
  runtime          = "python3.12"
  handler          = "session-insights.handler"
  filename         = data.archive_file.lambda["session_insights"].output_path
  source_code_hash = data.archive_file.lambda["session_insights"].output_base64sha256
  timeout          = 120
  memory_size      = 256

  environment {
    variables = {
      USAGE_TABLE_NAME    = aws_dynamodb_table.usage.name
      SESSIONS_TABLE_NAME = aws_dynamodb_table.sessions[0].name
      INSIGHTS_MODEL_ID   = var.session_insights_model_id
      INSIGHTS_LANGUAGE   = var.session_insights_language
    }
  }

  depends_on = [aws_cloudwatch_log_group.session_insights]
}

# Daily at 00:00 UTC (09:00 KST): analyze the previous UTC date.
resource "aws_cloudwatch_event_rule" "session_insights" {
  count               = local.session_insights_count
  name                = "${var.project_prefix}-session-insights"
  description         = "Daily Haiku analysis of client-reported session cost (previous UTC date)"
  schedule_expression = "cron(0 0 * * ? *)"
}

resource "aws_cloudwatch_event_target" "session_insights" {
  count = local.session_insights_count
  rule  = aws_cloudwatch_event_rule.session_insights[0].name
  arn   = aws_lambda_function.session_insights[0].arn
  input = jsonencode({ source = "cc.session-insights" })
}

resource "aws_lambda_permission" "session_insights" {
  count         = local.session_insights_count
  statement_id  = "AllowSessionInsightsSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.session_insights[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.session_insights[0].arn
}
