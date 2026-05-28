###############################################################################
# Root Module - Wires all infrastructure modules together.
# Mirrors cdk/bin/app.ts stack composition.
#
# Stack mapping (CDK -> Terraform module):
#   01-network-stack            -> modules/network
#   02-security-stack           -> modules/security
#   03-usage-tracking-stack     -> modules/usage-tracking
#   04-ecs-devenv-stack         -> modules/ecs-devenv         (skipped if governance_only)
#   05-dashboard-stack          -> modules/dashboard
#   06-waf-stack                -> modules/waf                (us-east-1)
#   07-ec2-devenv-stack         -> modules/ec2-devenv         (skipped if governance_only)
#   08-local-governance-stack   -> modules/local-governance
###############################################################################

locals {
  # Mirrors CDK `governanceOnly` context — gates EC2/ECS DevEnv stacks.
  governance_only = var.governance_only

  # ADR-014: Local Governance is deployed in both modes.
  # ECS + EC2 DevEnv are skipped only when governance_only=true.
  deploy_devenv = !local.governance_only
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
  hosted_zone_id         = var.hosted_zone_id
}

# ---- 02 Security -------------------------------------------------------------
module "security" {
  source = "./modules/security"

  project_prefix        = var.project_prefix
  domain_name           = var.domain_name
  dev_subdomain         = var.dev_subdomain
  dashboard_subdomain   = var.dashboard_subdomain
  cognito_domain_prefix = var.cognito_domain_prefix
  hosted_zone_id        = module.network.hosted_zone_id
  dashboard_cert_arn    = var.dashboard_cert_arn
}

# ---- 06 WAF (us-east-1, CloudFront scope) -----------------------------------
module "waf" {
  source = "./modules/waf"

  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  project_prefix = var.project_prefix
}

# ---- 03 Usage Tracking -------------------------------------------------------
module "usage_tracking" {
  source = "./modules/usage-tracking"

  project_prefix                = var.project_prefix
  kms_key_arn                   = module.security.kms_key_arn
  kms_key_id                    = module.security.kms_key_id
  user_pool_id                  = module.security.user_pool_id
  user_pool_arn                 = module.security.user_pool_arn
  ecs_cluster_name              = local.deploy_devenv ? module.ecs_devenv[0].cluster_name : "cc-on-bedrock-devenv"
  daily_budget_usd              = var.daily_budget_usd
  task_permission_boundary_name = module.security.task_permission_boundary_name
  department_budgets_table_name = module.security.department_budgets_table_name
  lambda_src_dir                = var.lambda_src_dir
}

# ---- 04 ECS Dev Environment (skipped when governance_only=true) -------------
module "ecs_devenv" {
  count  = local.deploy_devenv ? 1 : 0
  source = "./modules/ecs-devenv"

  vpc_id                    = module.network.vpc_id
  vpc_cidr                  = module.network.vpc_cidr
  public_subnet_ids         = module.network.public_subnet_ids
  private_subnet_ids        = module.network.private_subnet_ids
  isolated_subnet_ids       = module.network.isolated_subnet_ids
  kms_key_arn               = module.security.kms_key_arn
  kms_key_id                = module.security.kms_key_id
  devenv_certificate_arn    = module.security.devenv_certificate_arn
  hosted_zone_id            = module.network.hosted_zone_id
  domain_name               = var.domain_name
  dev_subdomain             = var.dev_subdomain
  cloudfront_secret_value   = module.security.cloudfront_secret_value
  ecs_host_instance_type    = var.ecs_host_instance_type
  cloudfront_prefix_list_id = var.cloudfront_prefix_list_id
  devenv_cf_cert_arn        = var.devenv_cert_arn
  web_acl_arn               = module.waf.web_acl_arn
}

# ---- 05 Dashboard ------------------------------------------------------------
module "dashboard" {
  source = "./modules/dashboard"

  vpc_id                              = module.network.vpc_id
  vpc_cidr                            = module.network.vpc_cidr
  public_subnet_ids                   = module.network.public_subnet_ids
  private_subnet_ids                  = module.network.private_subnet_ids
  kms_key_arn                         = module.security.kms_key_arn
  dashboard_ec2_instance_profile_name = module.security.dashboard_ec2_instance_profile_name
  dashboard_certificate_arn           = module.security.dashboard_certificate_arn
  hosted_zone_id                      = module.network.hosted_zone_id
  domain_name                         = var.domain_name
  dashboard_subdomain                 = var.dashboard_subdomain
  cloudfront_secret_value             = module.security.cloudfront_secret_value
  instance_type                       = var.dashboard_instance_type
  cloudfront_prefix_list_id           = var.cloudfront_prefix_list_id
  cloudfront_cert_arn                 = var.cloudfront_cert_arn
  web_acl_arn                         = module.waf.web_acl_arn
}

# ---- 07 EC2-per-user DevEnv (skipped when governance_only=true) -------------
module "ec2_devenv" {
  count  = local.deploy_devenv ? 1 : 0
  source = "./modules/ec2-devenv"

  project_prefix               = var.project_prefix
  vpc_id                       = module.network.vpc_id
  vpc_cidr                     = module.network.vpc_cidr
  kms_key_arn                  = module.security.kms_key_arn
  task_permission_boundary_arn = module.security.task_permission_boundary_arn
  devenv_instance_type         = var.devenv_instance_type
}

# ---- 08 Local Governance (ADR-014, always deployed) -------------------------
module "local_governance" {
  source = "./modules/local-governance"

  project_prefix                = var.project_prefix
  kms_key_arn                   = module.security.kms_key_arn
  kms_key_id                    = module.security.kms_key_id
  usage_table_stream_arn        = module.usage_tracking.usage_table_stream_arn
  task_permission_boundary_arn  = module.security.task_permission_boundary_arn
  task_permission_boundary_name = module.security.task_permission_boundary_name
  lambda_src_dir                = var.lambda_src_dir
}
