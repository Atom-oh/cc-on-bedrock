###############################################################################
# Root Module - Terraform-only canonical infrastructure composition
###############################################################################

locals {
  lambda_src_dir  = abspath("${path.module}/../lambda")
  deployment_mode = var.governance_only != null ? (var.governance_only ? "governance" : "devenv") : (var.deployment_mode == null ? "governance" : var.deployment_mode)
  devenv_enabled  = local.deployment_mode == "devenv"
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

# Upgrade guard: the default profile is governance, which removes every DevEnv resource.
# With neither deployment_mode nor governance_only set, refuse to plan while DevEnv
# security groups exist in the VPC, so an older tfvars cannot silently destroy DevEnvs.
data "aws_security_groups" "existing_devenv" {
  count = var.deployment_mode == null && var.governance_only == null ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }

  filter {
    name   = "group-name"
    values = ["cc-devenv-open-*"]
  }

  lifecycle {
    postcondition {
      condition     = length(self.ids) == 0
      error_message = "DevEnv security groups exist in this VPC but deployment_mode is not set. The default profile is now \"governance\", which destroys every DevEnv resource. Set deployment_mode = \"devenv\" to keep them, or deployment_mode = \"governance\" to remove them."
    }
  }
}

# ---- 01 Network -------------------------------------------------------------
module "network" {
  source = "./modules/network"

  name_prefix                 = var.vpc_name
  vpc_id                      = var.vpc_id
  public_subnet_ids           = var.public_subnet_ids
  private_subnet_ids          = var.private_subnet_ids
  isolated_subnet_ids         = var.isolated_subnet_ids
  interface_endpoint_services = var.interface_endpoint_services
  domain_name                 = var.domain_name
}

# ---- 02 Security -------------------------------------------------------------
module "security" {
  source = "./modules/security"

  domain_name         = var.domain_name
  dev_subdomain       = var.dev_subdomain
  hosted_zone_id      = module.network.hosted_zone_id
  dashboard_subdomain = var.dashboard_subdomain
  lambda_src_dir      = local.lambda_src_dir
  devenv_enabled      = local.devenv_enabled

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
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
  devenv_enabled                = local.devenv_enabled
  ecs_cluster_name              = var.ecs_cluster_name
  daily_budget_usd              = var.daily_budget_usd
  weekly_budget_usd             = var.weekly_budget_usd
  monthly_budget_usd            = var.monthly_budget_usd
  instance_table_name           = local.devenv_enabled ? module.ec2_devenv[0].instance_table_name : "cc-user-instances"
  routing_table_name            = local.devenv_enabled ? module.ecs_devenv[0].routing_table_name : "cc-routing-table"
  # OTel collector (Fargate + internal NLB:4318 OTLP/HTTP) networking — without these the collector
  # SG/NLB get empty vpc_cidr/subnets and terraform errors on an invalid CIDR.
  vpc_id             = module.network.vpc_id
  vpc_cidr           = module.network.vpc_cidr
  private_subnet_ids = module.network.private_subnet_ids
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
  dev_subdomain                       = var.dev_subdomain
  cloudfront_secret_value             = module.security.cloudfront_secret_value
  cognito_cli_public_client_id        = module.security.cli_public_client_id
  user_pool_id                        = module.security.user_pool_id
  user_pool_client_id                 = module.security.user_pool_client_id
  nextauth_secret_ssm_parameter_arn   = module.security.nextauth_secret_ssm_parameter_arn
  dashboard_ecr_repository_url        = module.security.dashboard_ecr_repository_url
  dashboard_image_tag                 = var.dashboard_image_tag
  instance_type                       = var.dashboard_instance_type
  dashboard_subdomain                 = var.dashboard_subdomain
  instance_table_name                 = local.devenv_enabled ? module.ec2_devenv[0].instance_table_name : local.default_dev_env
  routing_table_name                  = local.devenv_enabled ? module.ecs_devenv[0].routing_table_name : local.default_dev_env
  devenv_launch_template_name         = local.devenv_enabled ? module.ec2_devenv[0].launch_template_name : local.default_dev_env
  devenv_sg_open_id                   = local.devenv_enabled ? module.ec2_devenv[0].sg_open_id : local.default_dev_env
  devenv_sg_restricted_id             = local.devenv_enabled ? module.ec2_devenv[0].sg_restricted_id : local.default_dev_env
  devenv_sg_locked_id                 = local.devenv_enabled ? module.ec2_devenv[0].sg_locked_id : local.default_dev_env
  otel_collector_endpoint             = module.usage_tracking.otel_collector_endpoint
  dns_firewall_rule_group_id          = module.network.dns_firewall_rule_group_id
  codex_model_id                      = var.codex_model_id
  deployment_mode                     = local.deployment_mode
  ccdash_url                          = var.ccdash_url
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
  otel_collector_security_group_ids = [
    module.usage_tracking.otel_nlb_security_group_id,
    module.ecs_devenv[0].otel_collector_security_group_id,
  ]
  vpc_endpoint_security_group_ids = concat(
    module.network.vpc_endpoint_security_group_ids,
    var.existing_vpc_endpoint_security_group_ids,
  )
}

# DevEnv tiers -> both OTEL collectors (OTLP/HTTP 4318), by SG reference. Lives here
# because the collectors' modules and ec2-devenv would otherwise reference each other.
locals {
  otel_ingress = local.devenv_enabled ? merge([
    for sg_key, sg_id in {
      open       = module.ec2_devenv[0].sg_open_id
      restricted = module.ec2_devenv[0].sg_restricted_id
      locked     = module.ec2_devenv[0].sg_locked_id
      } : {
      "rollup-${sg_key}" = { target = module.usage_tracking.otel_nlb_security_group_id, source = sg_id }
      "ecs-${sg_key}"    = { target = module.ecs_devenv[0].otel_collector_security_group_id, source = sg_id }
    }
  ]...) : {}
}

resource "aws_vpc_security_group_ingress_rule" "otel_from_devenv" {
  for_each = local.otel_ingress

  security_group_id            = each.value.target
  description                  = "OTLP HTTP from DevEnv (${each.key})"
  ip_protocol                  = "tcp"
  from_port                    = 4318
  to_port                      = 4318
  referenced_security_group_id = each.value.source
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
