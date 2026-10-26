###############################################################################
# ADR-014 (amended 2026-10-26): audit for Codex on bedrock-mantle
#
# Mantle inference (`CreateInference`) is a CloudTrail DATA event and never reaches
# the Bedrock invocation log, so it is audited but NOT metered. Mantle's GPT models
# exist only in us-east-1: a single-region trail there records the data events, a
# us-east-1 EventBridge rule forwards them to this region's default bus, and the
# existing audit-logger writes them to cc-prompt-audit with provider = mantle.
###############################################################################

locals {
  mantle_trail_bucket = "${var.project_prefix}-mantle-trail-${local.account_id}"
  mantle_trail_name   = "${var.project_prefix}-mantle-audit"
}

resource "aws_s3_bucket" "mantle_trail" {
  count         = var.enable_mantle ? 1 : 0
  provider      = aws.us_east_1
  bucket        = local.mantle_trail_bucket
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "mantle_trail" {
  count                   = var.enable_mantle ? 1 : 0
  provider                = aws.us_east_1
  bucket                  = aws_s3_bucket.mantle_trail[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mantle_trail" {
  count    = var.enable_mantle ? 1 : 0
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.mantle_trail[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "mantle_trail" {
  count    = var.enable_mantle ? 1 : 0
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.mantle_trail[0].id
  rule {
    id     = "expire-90d"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

data "aws_iam_policy_document" "mantle_trail_bucket" {
  count = var.enable_mantle ? 1 : 0
  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.mantle_trail[0].arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:us-east-1:${local.account_id}:trail/${local.mantle_trail_name}"]
    }
  }
  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mantle_trail[0].arn}/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:us-east-1:${local.account_id}:trail/${local.mantle_trail_name}"]
    }
  }
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.mantle_trail[0].arn,
      "${aws_s3_bucket.mantle_trail[0].arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "mantle_trail" {
  count    = var.enable_mantle ? 1 : 0
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.mantle_trail[0].id
  policy   = data.aws_iam_policy_document.mantle_trail_bucket[0].json
}

resource "aws_cloudtrail" "mantle" {
  count                         = var.enable_mantle ? 1 : 0
  provider                      = aws.us_east_1
  name                          = local.mantle_trail_name
  s3_bucket_name                = aws_s3_bucket.mantle_trail[0].id
  is_multi_region_trail         = false
  include_global_service_events = false
  enable_log_file_validation    = true

  # Data events only (~$0.10 per 100k calls): management events are already free in
  # the account's event history.
  advanced_event_selector {
    name = "bedrock-mantle-inference"
    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }
    field_selector {
      field  = "resources.type"
      equals = ["AWS::BedrockMantle::Project"]
    }
  }

  depends_on = [aws_s3_bucket_policy.mantle_trail]
}

# us-east-1 → this region's default bus (cross-region targets must be event buses).
data "aws_iam_policy_document" "mantle_events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "mantle_events_forward" {
  count              = var.enable_mantle ? 1 : 0
  name               = "${var.project_prefix}-mantle-audit-forward"
  assume_role_policy = data.aws_iam_policy_document.mantle_events_assume.json
}

resource "aws_iam_role_policy" "mantle_events_forward" {
  count = var.enable_mantle ? 1 : 0
  name  = "put-events-home-bus"
  role  = aws_iam_role.mantle_events_forward[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:PutEvents"
      Resource = "arn:aws:events:${local.region}:${local.account_id}:event-bus/default"
    }]
  })
}

locals {
  mantle_inference_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["bedrock-mantle.amazonaws.com"]
      eventName   = ["CreateInference"]
    }
  })
}

resource "aws_cloudwatch_event_rule" "mantle_forward" {
  count         = var.enable_mantle ? 1 : 0
  provider      = aws.us_east_1
  name          = "${var.project_prefix}-mantle-audit-forward"
  description   = "Forward bedrock-mantle CreateInference data events to the home-region audit-logger"
  event_pattern = local.mantle_inference_pattern
}

resource "aws_cloudwatch_event_target" "mantle_forward" {
  count    = var.enable_mantle ? 1 : 0
  provider = aws.us_east_1
  rule     = aws_cloudwatch_event_rule.mantle_forward[0].name
  arn      = "arn:aws:events:${local.region}:${local.account_id}:event-bus/default"
  role_arn = aws_iam_role.mantle_events_forward[0].arn
}

resource "aws_cloudwatch_event_rule" "mantle_audit" {
  count         = var.enable_mantle ? 1 : 0
  name          = "${var.project_prefix}-mantle-audit"
  description   = "bedrock-mantle CreateInference (forwarded from us-east-1) → audit-logger"
  event_pattern = local.mantle_inference_pattern
}

resource "aws_cloudwatch_event_target" "mantle_audit" {
  count = var.enable_mantle ? 1 : 0
  rule  = aws_cloudwatch_event_rule.mantle_audit[0].name
  arn   = aws_lambda_function.audit_logger.arn
}

resource "aws_lambda_permission" "mantle_audit" {
  count         = var.enable_mantle ? 1 : 0
  statement_id  = "AllowMantleAudit"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.audit_logger.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.mantle_audit[0].arn
}
