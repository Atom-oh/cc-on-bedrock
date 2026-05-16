variable "project_prefix" {
  type    = string
  default = "cc-on-bedrock"
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "task_permission_boundary_arn" {
  type = string
}

variable "devenv_instance_type" {
  type    = string
  default = "t4g.large"
}
