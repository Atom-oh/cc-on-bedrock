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

variable "instance_type" {
  type    = string
  default = "t4g.xlarge"
}

variable "otel_collector_endpoint" {
  description = "Internal OTLP/gRPC endpoint (NLB DNS:4317); empty = telemetry off"
  type        = string
  default     = ""
}
