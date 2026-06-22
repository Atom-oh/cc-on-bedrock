###############################################################################
# Root variables for the Terraform-only CC on Bedrock deployment
###############################################################################

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-northeast-2"
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
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr_a" {
  type    = string
  default = "10.0.1.0/24"
}

variable "public_subnet_cidr_c" {
  type    = string
  default = "10.0.2.0/24"
}

variable "private_subnet_cidr_a" {
  type    = string
  default = "10.0.16.0/20"
}

variable "private_subnet_cidr_c" {
  type    = string
  default = "10.0.32.0/20"
}

variable "isolated_subnet_cidr_a" {
  type    = string
  default = "10.0.100.0/23"
}

variable "isolated_subnet_cidr_c" {
  type    = string
  default = "10.0.102.0/23"
}

# ---- Domain ------------------------------------------------------------------
variable "domain_name" {
  description = "Root domain name"
  type        = string
  default     = "example.com"
}

variable "dev_subdomain" {
  description = "Subdomain prefix for dev environments"
  type        = string
  default     = "dev"
}

# ---- Models ------------------------------------------------------------------
variable "opus_model_id" {
  type    = string
  default = "global.anthropic.claude-opus-4-8[1m]"
}

variable "sonnet_model_id" {
  type    = string
  default = "global.anthropic.claude-sonnet-4-6[1m]"
}

variable "ecs_cluster_name" {
  description = "ECS cluster name for the Nginx routing path"
  type        = string
  default     = "cc-on-bedrock-devenv"
}

variable "daily_budget_usd" {
  description = "Default daily per-user budget used by the budget-check Lambda"
  type        = number
  default     = 50
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
  description = "Per-user DevEnv EC2 instance type (ADR-004)"
  type        = string
  default     = "t4g.large"
}
