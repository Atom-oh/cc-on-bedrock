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

variable "dashboard_subdomain" {
  description = "Subdomain prefix for the dashboard (e.g. cconbedrock-dashboard)"
  type        = string
  default     = "cconbedrock-dashboard"
}

variable "cloudfront_secret_value" {
  type      = string
  sensitive = true
}

variable "instance_type" {
  type    = string
  default = "t4g.xlarge"
}

variable "cloudfront_prefix_list_id" {
  description = "CloudFront managed prefix list id (region-specific). ap-northeast-2 → pl-22a6434b"
  type        = string
  default     = "pl-22a6434b"
}

variable "cloudfront_cert_arn" {
  description = "Optional us-east-1 ACM cert ARN for the Dashboard CloudFront distribution. If empty, CloudFront default cert is used (custom domain alias still resolves)."
  type        = string
  default     = ""
}

variable "web_acl_arn" {
  description = "Optional CLOUDFRONT-scope WAF Web ACL ARN to attach to this distribution"
  type        = string
  default     = ""
}
