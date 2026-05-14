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

# ---- 04 ECS DevEnv (Cluster + NLB + Nginx) -----------------------------------
module "ecs_devenv" {
  source = "./modules/ecs-devenv"

  vpc_id                  = module.network.vpc_id
  vpc_cidr                = module.network.vpc_cidr
  public_subnet_ids       = module.network.public_subnet_ids
  private_subnet_ids      = module.network.private_subnet_ids
  kms_key_arn             = module.security.kms_key_arn
  domain_name             = var.domain_name
  dev_subdomain           = var.dev_subdomain
  cloudfront_secret_value = module.security.cloudfront_secret_value
  ecs_host_instance_type  = var.ecs_host_instance_type
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
}
