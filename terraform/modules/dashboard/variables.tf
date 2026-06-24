variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "kms_key_arn" {
  type = string
}

variable "dashboard_ec2_instance_profile_name" {
  type = string
}

variable "dashboard_certificate_arn" {
  type = string
}

variable "hosted_zone_id" {
  type = string
}

variable "domain_name" {
  type = string

  validation {
    condition     = can(regex("^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$", var.domain_name))
    error_message = "domain_name must be a root DNS name such as example.com, without leading or trailing dots."
  }
}

variable "cloudfront_secret_value" {
  type      = string
  sensitive = true
}

variable "cognito_cli_public_client_id" {
  type = string
}

variable "user_pool_id" {
  type = string
}

variable "user_pool_client_id" {
  type = string
}

variable "nextauth_secret_ssm_parameter_arn" {
  type = string
}

variable "dev_subdomain" {
  description = "Subdomain prefix for dev environments"
  type        = string
  default     = "dev"
}

variable "dashboard_ecr_repository_url" {
  description = "Terraform-managed dashboard ECR repository URL"
  type        = string
}

variable "dashboard_image_tag" {
  description = "Dashboard image tag to deploy; set to an immutable build tag/commit SHA to trigger instance refresh."
  type        = string

  validation {
    condition     = var.dashboard_image_tag != "latest" && can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.dashboard_image_tag))
    error_message = "dashboard_image_tag must be a valid immutable Docker tag and must not be 'latest'."
  }
}

variable "instance_type" {
  type    = string
  default = "t4g.xlarge"
}

variable "dashboard_subdomain" {
  description = "Dashboard subdomain label"
  type        = string
  default     = "cconbedrock-dashboard"

  validation {
    condition     = can(regex("^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$", var.dashboard_subdomain))
    error_message = "dashboard_subdomain must be a single DNS label."
  }
}

variable "instance_table_name" {
  type = string
}

variable "routing_table_name" {
  type = string
}

variable "devenv_launch_template_name" {
  type = string
}

variable "devenv_sg_open_id" {
  type = string
}

variable "devenv_sg_restricted_id" {
  type = string
}

variable "devenv_sg_locked_id" {
  type = string
}

variable "otel_collector_endpoint" {
  description = "Internal OTLP endpoint; empty = telemetry off"
  type        = string
  default     = ""
}

variable "dns_firewall_rule_group_id" {
  type = string
}
