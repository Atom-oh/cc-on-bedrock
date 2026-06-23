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
  description = "ARN of the permissions boundary to attach to the DevEnv instance IAM role."
  type        = string
  default     = ""
}

variable "devenv_instance_type" {
  type    = string
  default = "t4g.large"
}

variable "nginx_security_group_id" {
  description = "Security group ID of the shared Nginx ECS router allowed to reach code-server and custom ports"
  type        = string
  default     = ""
}
