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

variable "existing_user_pool_id" {
  description = "Reuse this Cognito user pool instead of creating cc-on-bedrock-users (null = create)"
  type        = string
  default     = null
}
