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

# ECS DevEnv
output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.ecs_devenv.cluster_name
}

output "efs_id" {
  description = "EFS file system ID"
  value       = module.ecs_devenv.efs_id
}

output "devenv_cloudfront_domain" {
  description = "Dev environment CloudFront domain"
  value       = module.ecs_devenv.cloudfront_domain
}

output "devenv_ecr_url" {
  description = "DevEnv ECR repository URL"
  value       = module.ecs_devenv.ecr_repository_url
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

# EC2 DevEnv (ADR-004) — DLP security groups, consumed as SG_DEVENV_* env vars
output "devenv_sg_open_id" {
  description = "DLP open-tier security group"
  value       = module.ec2_devenv.sg_open_id
}

output "devenv_sg_restricted_id" {
  description = "DLP restricted-tier security group"
  value       = module.ec2_devenv.sg_restricted_id
}

output "devenv_sg_locked_id" {
  description = "DLP locked-tier security group"
  value       = module.ec2_devenv.sg_locked_id
}

output "devenv_launch_template_id" {
  description = "Per-user DevEnv launch template"
  value       = module.ec2_devenv.launch_template_id
}
