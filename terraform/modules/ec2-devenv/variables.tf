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
  description = "ARN of the permissions boundary to attach to the DevEnv instance IAM role. Optional — CDK treats this as optional (cdk/lib/07-ec2-devenv-stack.ts: taskPermissionBoundary). Pass an empty string to skip."
  type        = string
  default     = ""
}

variable "devenv_instance_type" {
  type    = string
  default = "t4g.large"
}
