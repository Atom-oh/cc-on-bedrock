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
  description = "Deprecated; kept for tfvars compatibility. The Nginx router does not use isolated subnets."
  type        = list(string)
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

variable "nextauth_secret_ssm_parameter_arn" {
  description = "SSM parameter ARN containing the NextAuth secret consumed by the DevEnv Lambda@Edge validator"
  type        = string
}

variable "ecs_host_instance_type" {
  description = "Deprecated; the shared Nginx router runs on Fargate."
  type        = string
  default     = "m7g.4xlarge"
}

variable "lambda_src_dir" {
  description = "Absolute path to canonical Lambda source directory (repo lambda/)"
  type        = string
}

variable "web_acl_arn" {
  description = "Optional CloudFront WAF WebACL ARN"
  type        = string
  default     = ""
}
