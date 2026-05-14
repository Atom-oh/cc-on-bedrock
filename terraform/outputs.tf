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

output "devenv_nlb_dns" {
  description = "Dev environment NLB DNS name"
  value       = module.ecs_devenv.nlb_dns
}

output "routing_table_name" {
  description = "DynamoDB routing table name"
  value       = module.ecs_devenv.routing_table_name
}

output "devenv_ecr_url" {
  description = "DevEnv ECR repository URL"
  value       = module.ecs_devenv.ecr_repository_url
}

output "nginx_ecr_url" {
  description = "Nginx ECR repository URL"
  value       = module.ecs_devenv.nginx_ecr_repository_url
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
