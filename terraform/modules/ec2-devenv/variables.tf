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

variable "otel_collector_subnet_cidrs" {
  description = "CIDRs of the private subnets the OTEL collector's NLB lives in -- OTLP/HTTP:4318 egress is scoped to these instead of the whole VPC CIDR. Not the collector's own SG: the NLB is pre-existing with no SG attached, and adding one would force a replace (new DNS, telemetry outage on apply) -- see usage-tracking/main.tf's aws_lb.otel comment."
  type        = list(string)
  default     = []
}
