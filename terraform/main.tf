###############################################################################
# Root Module - Terraform-only canonical infrastructure composition
###############################################################################

locals {
  lambda_src_dir  = abspath("${path.module}/../lambda")
  devenv_enabled  = !var.governance_only
  default_dev_env = ""
}

moved {
  from = module.ecs_devenv
  to   = module.ecs_devenv[0]
}

moved {
  from = module.ec2_devenv
  to   = module.ec2_devenv[0]
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

  domain_name         = var.domain_name
  dev_subdomain       = var.dev_subdomain
  hosted_zone_id      = module.network.hosted_zone_id
  dashboard_subdomain = var.dashboard_subdomain
  lambda_src_dir      = local.lambda_src_dir
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
  count  = local.devenv_enabled ? 1 : 0
  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  vpc_id                            = module.network.vpc_id
  vpc_cidr                          = module.network.vpc_cidr
  public_subnet_ids                 = module.network.public_subnet_ids
  private_subnet_ids                = module.network.private_subnet_ids
  isolated_subnet_ids               = module.network.isolated_subnet_ids
  kms_key_arn                       = module.security.kms_key_arn
  kms_key_id                        = module.security.kms_key_id
  devenv_certificate_arn            = module.security.devenv_certificate_arn
  hosted_zone_id                    = module.network.hosted_zone_id
  domain_name                       = var.domain_name
  dev_subdomain                     = var.dev_subdomain
  cloudfront_secret_value           = module.security.cloudfront_secret_value
  nextauth_secret_ssm_parameter_arn = module.security.nextauth_secret_ssm_parameter_arn
  ecs_host_instance_type            = var.ecs_host_instance_type
  lambda_src_dir                    = local.lambda_src_dir
  web_acl_arn                       = module.waf.web_acl_arn
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
  cognito_cli_public_client_id        = module.security.cli_public_client_id
  nextauth_secret                     = module.security.nextauth_secret_value
  instance_type                       = var.dashboard_instance_type
  dashboard_subdomain                 = var.dashboard_subdomain
  instance_table_name                 = local.devenv_enabled ? module.ec2_devenv[0].instance_table_name : local.default_dev_env
  routing_table_name                  = local.devenv_enabled ? module.ecs_devenv[0].routing_table_name : local.default_dev_env
  devenv_launch_template_name         = local.devenv_enabled ? module.ec2_devenv[0].launch_template_name : local.default_dev_env
  devenv_sg_open_id                   = local.devenv_enabled ? module.ec2_devenv[0].sg_open_id : local.default_dev_env
  devenv_sg_restricted_id             = local.devenv_enabled ? module.ec2_devenv[0].sg_restricted_id : local.default_dev_env
  devenv_sg_locked_id                 = local.devenv_enabled ? module.ec2_devenv[0].sg_locked_id : local.default_dev_env
  otel_collector_endpoint             = local.devenv_enabled ? module.ecs_devenv[0].otel_collector_endpoint : local.default_dev_env
  dns_firewall_rule_group_id          = module.network.dns_firewall_rule_group_id
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
  count  = local.devenv_enabled ? 1 : 0

  vpc_id                       = module.network.vpc_id
  vpc_cidr                     = module.network.vpc_cidr
  kms_key_arn                  = module.security.kms_key_arn
  devenv_instance_type         = var.devenv_instance_type
  task_permission_boundary_arn = module.security.task_permission_boundary_arn
  nginx_security_group_id      = local.devenv_enabled ? module.ecs_devenv[0].nginx_security_group_id : local.default_dev_env
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
