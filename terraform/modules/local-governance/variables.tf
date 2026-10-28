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

variable "usage_table_stream_arn" {
  description = "DDB stream ARN of the cc-on-bedrock-usage table (token-limit-enforcer subscribes here)"
  type        = string
}

variable "task_permission_boundary_arn" {
  type = string
}

variable "task_permission_boundary_name" {
  type    = string
  default = "cc-on-bedrock-task-boundary"
}

variable "lambda_src_dir" {
  description = "Absolute path to canonical Lambda source directory (repo lambda/)"
  type        = string
}

variable "mantle_model_id" {
  description = "ADR-014: model the CLI writes into the Codex mantle profile"
  type        = string
  default     = "openai.gpt-6.1-sol"
}
