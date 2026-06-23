output "user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  value = aws_cognito_user_pool.this.arn
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.this.id
}

output "cli_public_client_id" {
  value = aws_cognito_user_pool_client.cli_public.id
}

output "devenv_certificate_arn" {
  value = aws_acm_certificate.devenv.arn
}

output "dashboard_certificate_arn" {
  value = aws_acm_certificate.dashboard.arn
}

output "kms_key_arn" {
  value = aws_kms_key.this.arn
}

output "kms_key_id" {
  value = aws_kms_key.this.key_id
}

output "cloudfront_secret_arn" {
  value = aws_secretsmanager_secret.cloudfront_secret.arn
}

output "cloudfront_secret_value" {
  value     = random_password.cloudfront_secret.result
  sensitive = true
}

output "nextauth_secret_value" {
  value     = random_password.nextauth_secret.result
  sensitive = true
}

output "nextauth_secret_ssm_parameter_arn" {
  value = aws_ssm_parameter.nextauth_secret.arn
}

output "dashboard_ec2_role_arn" {
  value = aws_iam_role.dashboard_ec2.arn
}

output "dashboard_ec2_instance_profile_name" {
  value = aws_iam_instance_profile.dashboard_ec2.name
}

output "department_budgets_table_name" {
  value = aws_dynamodb_table.department_budgets.name
}

output "task_permission_boundary_arn" {
  value = aws_iam_policy.task_permission_boundary.arn
}

output "task_permission_boundary_name" {
  value = aws_iam_policy.task_permission_boundary.name
}
