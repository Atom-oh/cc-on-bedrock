###############################################################################
# Root Module - Terraform-only canonical infrastructure composition
###############################################################################

locals {
  lambda_src_dir = abspath("${path.module}/../lambda")
}

# ---- 01 Network -------------------------------------------------------------
module "network" {
  source = "./modules/network"

  vpc_name               = var.vpc_name
  vpc_cidr               = var.vpc_cidr
  public_subnet_cidr_a   = var.public_subnet_cidr_a
  public_subnet_cidr_c   = var.public_subnet_cidr_c
  private_subnet_cidr_a  = var.private_subnet_cidr_a
  private_subnet_cidr_c  = var.private_subnet_cidr_c
  isolated_subnet_cidr_a = var.isolated_subnet_cidr_a
  isolated_subnet_cidr_c = var.isolated_subnet_cidr_c
  domain_name            = var.domain_name
}

# ---- 02 Security -------------------------------------------------------------
module "security" {
  source = "./modules/security"

  domain_name    = var.domain_name
  dev_subdomain  = var.dev_subdomain
  hosted_zone_id = module.network.hosted_zone_id
}

# ---- 03 Usage Tracking -------------------------------------------------------
module "usage_tracking" {
  source = "./modules/usage-tracking"

  kms_key_arn                   = module.security.kms_key_arn
  kms_key_id                    = module.security.kms_key_id
  user_pool_id                  = module.security.user_pool_id
  user_pool_arn                 = module.security.user_pool_arn
  department_budgets_table_name = module.security.department_budgets_table_name
  task_permission_boundary_name = module.security.task_permission_boundary_name
  lambda_src_dir                = local.lambda_src_dir
  ecs_cluster_name              = var.ecs_cluster_name
  daily_budget_usd              = var.daily_budget_usd
}

# ---- 04 ECS Nginx Dev Environment -------------------------------------------
module "ecs_devenv" {
  source = "./modules/ecs-devenv"

  vpc_id                  = module.network.vpc_id
  vpc_cidr                = module.network.vpc_cidr
  public_subnet_ids       = module.network.public_subnet_ids
  private_subnet_ids      = module.network.private_subnet_ids
  isolated_subnet_ids     = module.network.isolated_subnet_ids
  kms_key_arn             = module.security.kms_key_arn
  kms_key_id              = module.security.kms_key_id
  devenv_certificate_arn  = module.security.devenv_certificate_arn
  hosted_zone_id          = module.network.hosted_zone_id
  domain_name             = var.domain_name
  dev_subdomain           = var.dev_subdomain
  cloudfront_secret_value = module.security.cloudfront_secret_value
  ecs_host_instance_type  = var.ecs_host_instance_type
  lambda_src_dir          = local.lambda_src_dir
  web_acl_arn             = module.waf.web_acl_arn
}

# ---- 05 Dashboard ------------------------------------------------------------
module "dashboard" {
  source = "./modules/dashboard"
  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  vpc_id                              = module.network.vpc_id
  vpc_cidr                            = module.network.vpc_cidr
  public_subnet_ids                   = module.network.public_subnet_ids
  private_subnet_ids                  = module.network.private_subnet_ids
  kms_key_arn                         = module.security.kms_key_arn
  dashboard_ec2_instance_profile_name = module.security.dashboard_ec2_instance_profile_name
  dashboard_certificate_arn           = module.security.dashboard_certificate_arn
  hosted_zone_id                      = module.network.hosted_zone_id
  domain_name                         = var.domain_name
  cloudfront_secret_value             = module.security.cloudfront_secret_value
  instance_type                       = var.dashboard_instance_type
  instance_table_name                 = module.ec2_devenv.instance_table_name
  routing_table_name                  = module.ecs_devenv.routing_table_name
  devenv_launch_template_name         = module.ec2_devenv.launch_template_name
  devenv_sg_open_id                   = module.ec2_devenv.sg_open_id
  devenv_sg_restricted_id             = module.ec2_devenv.sg_restricted_id
  devenv_sg_locked_id                 = module.ec2_devenv.sg_locked_id
  otel_collector_endpoint             = module.ecs_devenv.otel_collector_endpoint
}

# ---- 06 WAF ------------------------------------------------------------------
module "waf" {
  source = "./modules/waf"
  providers = {
    aws.us_east_1 = aws.us_east_1
  }
}

# ---- 07 EC2 Dev Environment (ADR-004 per-user EC2 + DLP SGs) ------------------
module "ec2_devenv" {
  source = "./modules/ec2-devenv"

  vpc_id                       = module.network.vpc_id
  vpc_cidr                     = module.network.vpc_cidr
  kms_key_arn                  = module.security.kms_key_arn
  devenv_instance_type         = var.devenv_instance_type
  task_permission_boundary_arn = module.security.task_permission_boundary_arn
  nginx_security_group_id      = module.ecs_devenv.nginx_security_group_id
}

# ---- 08 Local Governance -----------------------------------------------------
module "local_governance" {
  source = "./modules/local-governance"

  kms_key_arn                   = module.security.kms_key_arn
  kms_key_id                    = module.security.kms_key_id
  usage_table_stream_arn        = module.usage_tracking.usage_table_stream_arn
  task_permission_boundary_arn  = module.security.task_permission_boundary_arn
  task_permission_boundary_name = module.security.task_permission_boundary_name
  lambda_src_dir                = local.lambda_src_dir
}
