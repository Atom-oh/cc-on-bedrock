variable "project_prefix" {
  description = "Project name prefix used in resource names"
  type        = string
  default     = "cc-on-bedrock"
}

variable "domain_name" {
  type = string
}

variable "dev_subdomain" {
  type = string
}

variable "dashboard_subdomain" {
  description = "Subdomain prefix for the dashboard (e.g. cconbedrock-dashboard)"
  type        = string
  default     = "cconbedrock-dashboard"
}

variable "cognito_domain_prefix" {
  description = "Prefix for the Cognito Hosted UI domain (must be globally unique within region)"
  type        = string
  default     = "cc-on-bedrock-ent"
}

variable "hosted_zone_id" {
  type = string
}

variable "dashboard_cert_arn" {
  description = "Optional pre-validated ap-northeast-2 ACM cert ARN. If empty, this module creates + DNS-validates one."
  type        = string
  default     = ""
}
