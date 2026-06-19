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
  default     = "../cdk/lib/lambda"
}
