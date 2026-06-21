###############################################################################
# Root Module - Wires all 5 infrastructure modules together
# Mirrors the CDK app.ts stack composition
###############################################################################

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

# ---- 03 ECS Dev Environment --------------------------------------------------
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
  lambda_src_dir          = var.lambda_src_dir
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
  cloudfront_secret_value             = module.security.cloudfront_secret_value
  instance_type                       = var.dashboard_instance_type
  otel_collector_endpoint             = module.usage_tracking.otel_collector_endpoint
}

# ---- 07 EC2 Dev Environment (ADR-004 per-user EC2 + DLP SGs) ------------------
module "ec2_devenv" {
  source = "./modules/ec2-devenv"

  vpc_id               = module.network.vpc_id
  vpc_cidr             = module.network.vpc_cidr
  kms_key_arn          = module.security.kms_key_arn
  devenv_instance_type = var.devenv_instance_type
  # task_permission_boundary_arn intentionally left default ("") — the boundary
  # is created by CDK Stack 02; pass its ARN via tfvars when running TF-only.
}

# ---- 03 Usage Tracking (DynamoDB, Lambdas, EventBridge, OTel) ----------------
module "usage_tracking" {
  source = "./modules/usage-tracking"

  kms_key_arn                   = module.security.kms_key_arn
  kms_key_id                    = module.security.kms_key_id
  user_pool_id                  = module.security.user_pool_id
  user_pool_arn                 = module.security.user_pool_arn
  department_budgets_table_name = module.security.department_budgets_table_name
  ecs_cluster_name              = module.ecs_devenv.cluster_name
  lambda_src_dir                = var.lambda_src_dir

  # Phase 1 (OTel) collector networking
  vpc_id             = module.network.vpc_id
  vpc_cidr           = module.network.vpc_cidr
  private_subnet_ids = module.network.private_subnet_ids
}

# ---- 08 Local Governance (ADR-014: STS issuer, limits, enforcers) ------------
module "local_governance" {
  source = "./modules/local-governance"

  kms_key_arn                   = module.security.kms_key_arn
  kms_key_id                    = module.security.kms_key_id
  usage_table_stream_arn        = module.usage_tracking.usage_table_stream_arn
  task_permission_boundary_arn  = module.security.task_permission_boundary_arn
  task_permission_boundary_name = module.security.task_permission_boundary_name
  lambda_src_dir                = var.lambda_src_dir
}

# ---- 06 WAF (CLOUDFRONT-scope WebACL, us-east-1) -----------------------------
module "waf" {
  source = "./modules/waf"
  providers = {
    aws.us_east_1 = aws.us_east_1
  }
}
