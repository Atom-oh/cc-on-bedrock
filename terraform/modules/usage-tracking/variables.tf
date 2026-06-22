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
  description = "Absolute path to canonical Lambda source directory (repo lambda/)"
  type        = string
}
