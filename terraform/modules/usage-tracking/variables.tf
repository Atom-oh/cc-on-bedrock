variable "project_prefix" {
  type    = string
  default = "cc-on-bedrock"
}

variable "kms_key_arn" {
  type = string
}

variable "kms_key_id" {
  type = string
}

variable "user_pool_id" {
  type = string
}

variable "user_pool_arn" {
  type = string
}

variable "ecs_cluster_name" {
  type    = string
  default = "cc-on-bedrock-devenv"
}

variable "daily_budget_usd" {
  type    = number
  default = 50
}

variable "task_permission_boundary_name" {
  description = "Name of the cc-on-bedrock-task-boundary managed policy"
  type        = string
  default     = "cc-on-bedrock-task-boundary"
}

variable "department_budgets_table_name" {
  description = "cc-department-budgets table name (created in security module)"
  type        = string
}

variable "lambda_src_dir" {
  description = "Absolute path to CDK Lambda source directory (cdk/lib/lambda)"
  type        = string
}

# Phase 1 (OTel) — collector Fargate service networking
variable "vpc_id" {
  description = "VPC for the OTel collector Fargate service + NLB"
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  description = "VPC CIDR — OTLP/gRPC (4317) ingress is restricted to this"
  type        = string
  default     = ""
}

variable "private_subnet_ids" {
  description = "Private subnets for the internal NLB + collector tasks"
  type        = list(string)
  default     = []
}
