###############################################################################
# Root Outputs
###############################################################################

# Network
output "vpc_id" {
  description = "VPC ID"
  value       = module.network.vpc_id
}

output "hosted_zone_id" {
  description = "Route 53 hosted zone ID"
  value       = module.network.hosted_zone_id
}

# Security
output "user_pool_id" {
  description = "Cognito User Pool ID"
  value       = module.security.user_pool_id
}

output "user_pool_client_id" {
  description = "Cognito User Pool Client ID"
  value       = module.security.user_pool_client_id
}

output "cognito_cli_public_client_id" {
  description = "Cognito public app client ID used by cc-bedrock-local"
  value       = module.security.cli_public_client_id
}

# ECS DevEnv
output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = var.governance_only ? null : module.ecs_devenv[0].cluster_name
}

output "devenv_cloudfront_domain" {
  description = "Dev environment CloudFront domain"
  value       = var.governance_only ? null : module.ecs_devenv[0].cloudfront_domain
}

output "devenv_nlb_dns" {
  description = "DevEnv NLB DNS name for the shared Nginx router"
  value       = var.governance_only ? null : module.ecs_devenv[0].nlb_dns
}

output "nginx_ecr_url" {
  description = "Nginx router ECR repository URL"
  value       = var.governance_only ? null : module.ecs_devenv[0].nginx_ecr_repository_url
}

output "routing_table_name" {
  description = "Nginx routing table"
  value       = var.governance_only ? null : module.ecs_devenv[0].routing_table_name
}

output "otel_collector_endpoint" {
  description = "Internal OTLP HTTP endpoint for EC2 code activity metrics"
  value       = var.governance_only ? null : module.ecs_devenv[0].otel_collector_endpoint
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

output "dashboard_ecr_url" {
  description = "Dashboard ECR repository URL"
  value       = module.security.dashboard_ecr_repository_url
}

# EC2 DevEnv (ADR-004) — DLP security groups, consumed as SG_DEVENV_* env vars
output "devenv_sg_open_id" {
  description = "DLP open-tier security group"
  value       = var.governance_only ? null : module.ec2_devenv[0].sg_open_id
}

output "devenv_sg_restricted_id" {
  description = "DLP restricted-tier security group"
  value       = var.governance_only ? null : module.ec2_devenv[0].sg_restricted_id
}

output "devenv_sg_locked_id" {
  description = "DLP locked-tier security group"
  value       = var.governance_only ? null : module.ec2_devenv[0].sg_locked_id
}

output "devenv_launch_template_id" {
  description = "Per-user DevEnv launch template"
  value       = var.governance_only ? null : module.ec2_devenv[0].launch_template_id
}

output "usage_table_name" {
  description = "Bedrock usage aggregation table"
  value       = module.usage_tracking.usage_table_name
}

output "local_governance_limits_table_name" {
  description = "Normalized token limit table"
  value       = module.local_governance.limits_table_name
}

output "sts_issuer_function_url" {
  description = "Local Mode STS issuer Lambda Function URL"
  value       = module.local_governance.sts_issuer_function_url
}

output "cloudfront_waf_acl_arn" {
  description = "CloudFront-scope WAF WebACL ARN"
  value       = module.waf.web_acl_arn
}

output "dns_firewall_rule_group_id" {
  description = "Route 53 Resolver DNS Firewall rule group for managed threat and DLP domain rules"
  value       = module.network.dns_firewall_rule_group_id
}
