output "limits_table_name" {
  value = aws_dynamodb_table.limits.name
}

output "limits_table_arn" {
  value = aws_dynamodb_table.limits.arn
}

output "sts_issuer_function_name" {
  value = aws_lambda_function.sts_issuer.function_name
}

output "sts_issuer_function_arn" {
  value = aws_lambda_function.sts_issuer.arn
}

output "sts_issuer_function_url" {
  value = aws_lambda_function_url.sts_issuer.function_url
}

output "alert_topic_arn" {
  value = aws_sns_topic.local_gov_alerts.arn
}
