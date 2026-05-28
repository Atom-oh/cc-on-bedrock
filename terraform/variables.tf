###############################################################################
# Root variables - mirrors cdk/config/default.ts CcOnBedrockConfig
###############################################################################

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-northeast-2"
}

# ---- Project -----------------------------------------------------------------
variable "project_prefix" {
  description = "Project name prefix used in resource names"
  type        = string
  default     = "cc-on-bedrock"
}

# ---- Network ----------------------------------------------------------------
variable "vpc_name" {
  description = "Name tag for the VPC"
  type        = string
  default     = "cc-on-bedrock-vpc"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.100.0.0/16"
}

variable "public_subnet_cidr_a" {
  type    = string
  default = "10.100.1.0/24"
}

variable "public_subnet_cidr_c" {
  type    = string
  default = "10.100.2.0/24"
}

variable "private_subnet_cidr_a" {
  type    = string
  default = "10.100.16.0/20"
}

variable "private_subnet_cidr_c" {
  type    = string
  default = "10.100.32.0/20"
}

variable "isolated_subnet_cidr_a" {
  type    = string
  default = "10.100.100.0/23"
}

variable "isolated_subnet_cidr_c" {
  type    = string
  default = "10.100.102.0/23"
}

# ---- Domain ------------------------------------------------------------------
variable "domain_name" {
  description = "Root domain name"
  type        = string
  default     = "atomai.click"
}

variable "hosted_zone_id" {
  description = "Optional existing Route 53 public hosted zone ID. If empty, a new zone is created. Mirrors CDK config.hostedZoneId."
  type        = string
  default     = ""
}

variable "dev_subdomain" {
  description = "Subdomain prefix for dev environments"
  type        = string
  default     = "dev"
}

variable "dashboard_subdomain" {
  description = "Subdomain prefix for the dashboard"
  type        = string
  default     = "cconbedrock-dashboard"
}

variable "cognito_domain_prefix" {
  description = "Prefix for the Cognito Hosted UI domain"
  type        = string
  default     = "cc-on-bedrock-ent"
}

# ---- Models ------------------------------------------------------------------
variable "opus_model_id" {
  type    = string
  default = "global.anthropic.claude-opus-4-6-v1[1m]"
}

variable "sonnet_model_id" {
  type    = string
  default = "global.anthropic.claude-sonnet-4-6[1m]"
}

# ---- Compute -----------------------------------------------------------------
variable "ecs_host_instance_type" {
  type    = string
  default = "m7g.4xlarge"
}

variable "dashboard_instance_type" {
  type    = string
  default = "t4g.xlarge"
}

variable "devenv_instance_type" {
  description = "Per-user EC2 DevEnv instance type (ADR-004)"
  type        = string
  default     = "t4g.large"
}

# ---- Budget ------------------------------------------------------------------
variable "daily_budget_usd" {
  description = "Daily budget per user in USD (mirrors CDK dailyBudgetUsd)"
  type        = number
  default     = 50
}

# ---- CloudFront --------------------------------------------------------------
variable "cloudfront_prefix_list_id" {
  description = "CloudFront managed prefix list id (region-specific). ap-northeast-2 → pl-22a6434b"
  type        = string
  default     = "pl-22a6434b"
}

# ---- ACM Certificate ARNs ---------------------------------------------------
# Pre-validate these in us-east-1 (CloudFront) and ap-northeast-2 (ALB) and
# pass the ARNs in via tfvars. Mirrors CDK context cloudfrontCertArn /
# devEnvCertArn / dashboardCertArn.
variable "cloudfront_cert_arn" {
  description = "us-east-1 ACM cert for the Dashboard CloudFront distribution (e.g. *.atomai.click). If empty, CloudFront default cert is used."
  type        = string
  default     = ""
}

variable "devenv_cert_arn" {
  description = "us-east-1 ACM cert for the DevEnv CloudFront distribution (*.dev.<domain>). If empty, default cert is used."
  type        = string
  default     = ""
}

variable "dashboard_cert_arn" {
  description = "ap-northeast-2 ACM cert for the ALB. If empty, the security module will create + DNS-validate one."
  type        = string
  default     = ""
}

# ---- Local Governance toggle ------------------------------------------------
variable "governance_only" {
  description = "If true, skip the EC2/ECS DevEnv stacks and only deploy the Local Governance layer (ADR-014). Mirrors CDK `--context governanceOnly=true`."
  type        = bool
  default     = false
}

# ---- Lambda source path -----------------------------------------------------
variable "lambda_src_dir" {
  description = "Absolute path to the CDK Lambda source directory. Defaults to ../cdk/lib/lambda relative to this root."
  type        = string
  default     = "../cdk/lib/lambda"
}
