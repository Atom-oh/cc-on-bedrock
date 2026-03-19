variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
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

variable "litellm_ec2_instance_profile_name" {
  type = string
}

variable "litellm_master_key_secret_arn" {
  type = string
}

variable "valkey_auth_secret_arn" {
  type = string
}

variable "instance_type" {
  type    = string
  default = "t4g.xlarge"
}

variable "rds_instance_type" {
  type    = string
  default = "db.t4g.medium"
}
