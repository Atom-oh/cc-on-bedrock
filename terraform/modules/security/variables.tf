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
