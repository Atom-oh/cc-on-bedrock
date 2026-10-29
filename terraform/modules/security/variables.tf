variable "domain_name" {
  type = string
}

variable "dev_subdomain" {
  type = string
}

variable "hosted_zone_id" {
  type = string
}

variable "user_pool_callback_url" {
  description = "OAuth callback URL for the Cognito user pool client"
  type        = string
  default     = ""
}

variable "project_prefix" {
  description = "Resource name prefix (ADR portability)"
  type        = string
  default     = "cc-on-bedrock"
}

variable "lambda_src_dir" {
  description = "Path to Lambda source (cdk/lib/lambda) for archive packaging"
  type        = string
  default     = "../lambda"
}

variable "dashboard_subdomain" {
  description = "Dashboard subdomain label"
  type        = string
  default     = "cconbedrock-dashboard"
}

variable "devenv_enabled" {
  description = "deployment_mode = \"devenv\": create the DevEnv wildcard certificate and the dashboard's EC2 DevEnv permissions"
  type        = bool
  default     = true
}

variable "enable_mantle" {
  description = "ADR-014: Codex on bedrock-mantle for unlimited users (unmetered)"
  type        = bool
  default     = false
}

variable "shared_user_pool_name" {
  description = "Name of an existing Cognito user pool to share with another app (empty = cc's own pool). Keep it in terraform.tfvars, never in code."
  type        = string
  default     = ""
}
