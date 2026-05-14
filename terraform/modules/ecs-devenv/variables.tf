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

variable "domain_name" {
  type = string
}

variable "dev_subdomain" {
  type = string
}

variable "cloudfront_secret_value" {
  type      = string
  sensitive = true
}

variable "cloudfront_prefix_list_id" {
  description = "CloudFront managed prefix list ID (region-specific)"
  type        = string
  default     = "pl-22a6434b" # ap-northeast-2 (Seoul)
}

variable "ecs_host_instance_type" {
  type    = string
  default = "t4g.xlarge"
}
