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
  description = "Name tag prefix for network resources this stack adds to the VPC"
  type        = string
  default     = "cc-on-bedrock"
}

# Bring-your-own VPC: the stack never creates a VPC, subnets, NAT or IGW.
variable "vpc_id" {
  description = "Existing VPC ID to deploy into"
  type        = string

  validation {
    condition     = can(regex("^vpc-[0-9a-f]+$", var.vpc_id))
    error_message = "vpc_id must be an existing VPC ID (vpc-...)."
  }
}

variable "public_subnet_ids" {
  description = "Public subnets in the VPC. Optional and unused by this stack (nothing is placed in them); passed through as the network module's output"
  type        = list(string)
  default     = []
}

variable "private_subnet_ids" {
  description = "Private subnets with NAT egress (two AZs): internal LBs, EC2, Fargate, interface endpoints"
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "private_subnet_ids needs at least two subnets in different AZs."
  }
}

variable "isolated_subnet_ids" {
  description = "Isolated subnets (no internet route) in the VPC"
  type        = list(string)
}

variable "interface_endpoint_services" {
  description = "Interface VPC endpoints to create, by service suffix. Leave out services the VPC already has with private DNS"
  type        = list(string)
  default     = ["ssm", "ssmmessages", "ec2messages", "ecr.api", "ecr.dkr", "bedrock-runtime", "logs"]
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

# Deployment profile. "governance" (effective default when unset): admin dashboard (usage,
# cost, budgets) plus the local installer; users run Claude Code / Codex on their own PC with
# Cognito-issued STS credentials, no EC2. "devenv": also provisions per-user EC2 DevEnvs behind CloudFront.
variable "deployment_mode" {
  description = "Deployment profile: \"governance\" (dashboard + local installer, no EC2) or \"devenv\" (adds per-user EC2 DevEnvs). null (unset) means \"governance\"; an unset mode refuses to plan while DevEnv security groups exist (upgrade guard)"
  type        = string
  default     = null

  validation {
    condition     = contains(["governance", "devenv"], var.deployment_mode == null ? "governance" : var.deployment_mode)
    error_message = "deployment_mode must be \"governance\" or \"devenv\" (or unset for governance)."
  }
}

# Deprecated: use deployment_mode. When set, it overrides deployment_mode so existing
# tfvars keep their profile (true = "governance", false = "devenv").
variable "governance_only" {
  description = "Deprecated alias of deployment_mode (true = governance, false = devenv); overrides it when set"
  type        = bool
  default     = null
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

variable "existing_vpc_endpoint_security_group_ids" {
  description = "Security groups of interface endpoints the VPC already had (not created here); the locked DevEnv tier may reach them on 443"
  type        = list(string)
  default     = []
}

# ADR-014 (amended 2026-10-26): Codex on bedrock-mantle (`codex -p mantle`, server-side
# web search) for users whose cost is unlimited. Mantle traffic is NOT metered; it is
# audited via a us-east-1 CloudTrail data-event trail. false = no grant, no trail.
variable "enable_mantle" {
  description = "Grant Codex bedrock-mantle (web search, unmetered) to users with no cost cap, with CloudTrail data-event audit in us-east-1"
  type        = bool
  default     = true
}

variable "codex_mantle_model_id" {
  description = "Model for the Codex mantle profile (us-east-1 bedrock-mantle model id, no CRIS prefix)"
  type        = string
  default     = "openai.gpt-6.1-sol"

  validation {
    condition     = can(regex("^openai\\.gpt-[A-Za-z0-9.-]+$", var.codex_mantle_model_id))
    error_message = "codex_mantle_model_id must be a bedrock-mantle OpenAI model id, e.g. openai.gpt-6.1-sol."
  }
}
