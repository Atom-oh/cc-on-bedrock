###############################################################################
# Root Outputs
###############################################################################

# Network
output "vpc_id" {
  description = "VPC ID"
  value       = module.network.vpc_id
}

output "vpc_cidr" {
  description = "VPC CIDR"
  value       = module.network.vpc_cidr
}

output "hosted_zone_id" {
  description = "Route 53 hosted zone ID (created or looked-up)"
  value       = module.network.hosted_zone_id
}

# Security
output "user_pool_id" {
  description = "Cognito User Pool ID"
  value       = module.security.user_pool_id
}

output "user_pool_client_id" {
  description = "Cognito User Pool Client ID (dashboard SSR client w/ secret)"
  value       = module.security.user_pool_client_id
}

output "cli_public_client_id" {
  description = "Cognito public app client id for the cc-bedrock-local CLI (no secret, ADR-014)"
  value       = module.security.cli_public_client_id
}

output "kms_key_arn" {
  description = "Project KMS key ARN"
  value       = module.security.kms_key_arn
}

output "task_permission_boundary_arn" {
  description = "ARN of the cc-on-bedrock-task-boundary managed policy"
  value       = module.security.task_permission_boundary_arn
}

# Usage tracking
output "usage_table_name" {
  value = module.usage_tracking.usage_table_name
}

output "usage_table_stream_arn" {
  value = module.usage_tracking.usage_table_stream_arn
}

# ECS DevEnv (only when deployed)
output "ecs_cluster_name" {
  description = "ECS cluster name (null when governance_only=true)"
  value       = local.deploy_devenv ? module.ecs_devenv[0].cluster_name : null
}

output "devenv_cloudfront_domain" {
  description = "DevEnv CloudFront domain (null when governance_only=true)"
  value       = local.deploy_devenv ? module.ecs_devenv[0].cloudfront_domain : null
}

output "devenv_ecr_url" {
  description = "DevEnv ECR repository URL (null when governance_only=true)"
  value       = local.deploy_devenv ? module.ecs_devenv[0].ecr_repository_url : null
}

# Dashboard
output "dashboard_url" {
  description = "Dashboard URL"
  value       = module.dashboard.dashboard_url
}

output "dashboard_cloudfront_domain" {
  description = "Dashboard CloudFront domain"
  value       = module.dashboard.cloudfront_domain
}

# WAF
output "waf_web_acl_arn" {
  description = "CloudFront-scope WAF Web ACL ARN (us-east-1)"
  value       = module.waf.web_acl_arn
}

# Local Governance
output "limits_table_name" {
  description = "ADR-014 limits table"
  value       = module.local_governance.limits_table_name
}

output "sts_issuer_function_url" {
  description = "STS issuer Lambda Function URL (IAM auth, ADR-014)"
  value       = module.local_governance.sts_issuer_function_url
}

# EC2 DevEnv (only when deployed)
output "ec2_devenv_launch_template_id" {
  description = "Per-user EC2 DevEnv launch template id (null when governance_only=true)"
  value       = local.deploy_devenv ? module.ec2_devenv[0].launch_template_id : null
}
