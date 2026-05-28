variable "vpc_name" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_cidr_a" {
  type = string
}

variable "public_subnet_cidr_c" {
  type = string
}

variable "private_subnet_cidr_a" {
  type = string
}

variable "private_subnet_cidr_c" {
  type = string
}

variable "isolated_subnet_cidr_a" {
  type = string
}

variable "isolated_subnet_cidr_c" {
  type = string
}

variable "domain_name" {
  type = string
}

variable "hosted_zone_id" {
  description = "Optional existing Route 53 public hosted zone ID. If empty, a new public zone is created (mirrors CDK config.hostedZoneId)."
  type        = string
  default     = ""
}
