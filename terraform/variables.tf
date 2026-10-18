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
  default = "global.anthropic.claude-opus-4-8"
}

variable "sonnet_model_id" {
  type    = string
  default = "global.anthropic.claude-sonnet-5"
}

# ADR-014 Codex on Bedrock: default OpenAI model for the Codex CLI. Must be a
# system-defined cross-Region profile (global./us.) — the bedrock-runtime
# Responses API rejects foundation-model IDs and application inference profiles.
variable "codex_model_id" {
  description = "Default Codex CLI model (bedrock-runtime Responses API, global CRIS profile)"
  type        = string
  default     = "global.openai.gpt-6.1-sol"

  validation {
    condition     = can(regex("^(global|us|eu|apac)\\.openai\\.gpt-[A-Za-z0-9.-]+$", var.codex_model_id))
    error_message = "codex_model_id must be a cross-Region OpenAI GPT inference profile ID (prefix global|us|eu|apac), e.g. global.openai.gpt-6.1-sol."
  }
}

variable "ecs_cluster_name" {
  description = "ECS cluster name for the Nginx routing path"
  type        = string
  default     = "cc-on-bedrock-devenv"
}

variable "daily_budget_usd" {
  description = "Global default daily per-user USD budget (used when neither the user nor the department sets one)"
  type        = number
  default     = 50

  validation {
    condition     = var.daily_budget_usd >= 0
    error_message = "daily_budget_usd must be >= 0."
  }
}

variable "weekly_budget_usd" {
  description = "Global default weekly (ISO week, UTC) per-user USD budget; 0 = no global weekly cap"
  type        = number
  default     = 0

  validation {
    condition     = var.weekly_budget_usd >= 0
    error_message = "weekly_budget_usd must be >= 0 (0 = no global cap)."
  }
}

variable "monthly_budget_usd" {
  description = "Global default monthly (calendar month, UTC) per-user USD budget; 0 = no global monthly cap"
  type        = number
  default     = 0

  validation {
    condition     = var.monthly_budget_usd >= 0
    error_message = "monthly_budget_usd must be >= 0 (0 = no global cap)."
  }
}

variable "governance_only" {
  description = "Deploy Local Governance mode without EC2/ECS DevEnv infrastructure"
  type        = bool
  default     = false
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

variable "dashboard_image_tag" {
  description = "Dashboard image tag deployed by the ASG launch template. Required; use an immutable build tag or commit SHA for deterministic rollouts."
  type        = string

  validation {
    condition     = var.dashboard_image_tag != "latest" && can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.dashboard_image_tag))
    error_message = "dashboard_image_tag must be a valid immutable Docker tag and must not be 'latest'."
  }
}

variable "devenv_instance_type" {
  description = "Per-user DevEnv EC2 instance type (ADR-004)"
  type        = string
  default     = "t4g.large"
}

variable "lambda_src_dir" {
  description = "Path to Lambda source (cdk/lib/lambda), relative to terraform/ root"
  type        = string
  default     = "../lambda"
}

variable "dashboard_subdomain" {
  description = "Dashboard subdomain label (CDK parity: cconbedrock-dashboard)"
  type        = string
  default     = "cconbedrock-dashboard"
}
