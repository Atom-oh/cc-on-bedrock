output "usage_table_name" {
  value = aws_dynamodb_table.usage.name
}

output "usage_table_arn" {
  value = aws_dynamodb_table.usage.arn
}

output "usage_table_stream_arn" {
  value = aws_dynamodb_table.usage.stream_arn
}

output "cli_tokens_table_name" {
  value = aws_dynamodb_table.cli_tokens.name
}

output "user_budgets_table_name" {
  value = aws_dynamodb_table.user_budgets.name
}

output "approval_requests_table_name" {
  value = aws_dynamodb_table.approval_requests.name
}

output "dlp_domain_lists_table_name" {
  value = aws_dynamodb_table.dlp_domain_lists.name
}

output "audit_table_name" {
  value = aws_dynamodb_table.prompt_audit.name
}

output "budget_alerts_topic_arn" {
  value = aws_sns_topic.budget_alerts.arn
}

output "tracker_lambda_arn" {
  value = aws_lambda_function.tracker.arn
}

output "audit_logger_lambda_arn" {
  value = aws_lambda_function.audit_logger.arn
}

output "gateway_manager_lambda_arn" {
  value = aws_lambda_function.gateway_manager.arn
}

output "mcp_catalog_table_name" {
  value = aws_dynamodb_table.mcp_catalog.name
}

output "dept_mcp_config_table_name" {
  value = aws_dynamodb_table.dept_mcp_config.name
}

output "otel_collector_endpoint" {
  description = "Internal OTLP/gRPC endpoint (NLB DNS:4317) for devenv telemetry push"
  value       = "${aws_lb.otel.dns_name}:4317"
}

output "otel_metrics_raw_bucket" {
  value = aws_s3_bucket.otel_raw.id
}
