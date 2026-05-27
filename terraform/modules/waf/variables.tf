variable "project_prefix" {
  type    = string
  default = "cc-on-bedrock"
}

variable "rate_limit_per_5m" {
  description = "Rate-based rule threshold per IP per 5 minutes"
  type        = number
  default     = 2000
}
