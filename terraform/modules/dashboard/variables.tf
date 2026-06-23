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
}

variable "cloudfront_secret_value" {
  type      = string
  sensitive = true
}

variable "cognito_cli_public_client_id" {
  type = string
}

variable "nextauth_secret" {
  type      = string
  sensitive = true
}

variable "instance_type" {
  type    = string
  default = "t4g.xlarge"
}

variable "dashboard_subdomain" {
  description = "Dashboard subdomain label"
  type        = string
  default     = "cconbedrock-dashboard"
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
