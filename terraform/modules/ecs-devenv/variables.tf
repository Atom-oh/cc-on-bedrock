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

variable "lambda_src_dir" {
  description = "Path to Lambda source (cdk/lib/lambda) for archive packaging"
  type        = string
  default     = "../cdk/lib/lambda"
}
