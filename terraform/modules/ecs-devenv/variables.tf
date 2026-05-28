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

variable "isolated_subnet_ids" {
  type = list(string)
}

variable "kms_key_arn" {
  type = string
}

variable "kms_key_id" {
  type = string
}

variable "devenv_certificate_arn" {
  type = string
}

variable "hosted_zone_id" {
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

variable "ecs_host_instance_type" {
  type    = string
  default = "m7g.4xlarge"
}

variable "cloudfront_prefix_list_id" {
  description = "CloudFront managed prefix list id (region-specific). ap-northeast-2 → pl-22a6434b"
  type        = string
  default     = "pl-22a6434b"
}

variable "devenv_cf_cert_arn" {
  description = "Optional us-east-1 ACM cert ARN for the DevEnv CloudFront distribution (*.dev.<domain>). If empty, CloudFront default cert is used."
  type        = string
  default     = ""
}

variable "web_acl_arn" {
  description = "Optional CLOUDFRONT-scope WAF Web ACL ARN to attach to the DevEnv distribution"
  type        = string
  default     = ""
}
