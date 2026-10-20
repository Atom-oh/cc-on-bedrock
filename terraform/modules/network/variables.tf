variable "vpc_id" {
  description = "Existing VPC ID; null creates a dedicated VPC."
  type        = string
  default     = null

  validation {
    condition     = var.vpc_id == null ? true : can(regex("^vpc-([0-9a-f]{8}|[0-9a-f]{17})$", var.vpc_id))
    error_message = "vpc_id must be null or a valid AWS VPC ID."
  }
}

variable "public_subnet_ids" {
  type     = list(string)
  default  = []
  nullable = false

  validation {
    condition = length(var.public_subnet_ids) == 0 || (
      length(var.public_subnet_ids) >= 2 &&
      length(distinct(var.public_subnet_ids)) == length(var.public_subnet_ids) &&
      alltrue([for id in var.public_subnet_ids : can(regex("^subnet-([0-9a-f]{8}|[0-9a-f]{17})$", id))])
    )
    error_message = "public_subnet_ids must be empty or contain at least two distinct AWS subnet IDs."
  }
}

variable "private_subnet_ids" {
  type     = list(string)
  default  = []
  nullable = false

  validation {
    condition = length(var.private_subnet_ids) == 0 || (
      length(var.private_subnet_ids) >= 2 &&
      length(distinct(var.private_subnet_ids)) == length(var.private_subnet_ids) &&
      alltrue([for id in var.private_subnet_ids : can(regex("^subnet-([0-9a-f]{8}|[0-9a-f]{17})$", id))])
    )
    error_message = "private_subnet_ids must be empty or contain at least two distinct AWS subnet IDs."
  }
}

variable "isolated_subnet_ids" {
  type     = list(string)
  default  = []
  nullable = false

  validation {
    condition = length(var.isolated_subnet_ids) == 0 || (
      length(var.isolated_subnet_ids) >= 2 &&
      length(distinct(var.isolated_subnet_ids)) == length(var.isolated_subnet_ids) &&
      alltrue([for id in var.isolated_subnet_ids : can(regex("^subnet-([0-9a-f]{8}|[0-9a-f]{17})$", id))])
    )
    error_message = "isolated_subnet_ids must be empty or contain at least two distinct AWS subnet IDs."
  }
}

variable "vpc_name" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_cidr_a" {
  type = string
}

variable "public_subnet_cidr_c" {
  type = string
}

variable "private_subnet_cidr_a" {
  type = string
}

variable "private_subnet_cidr_c" {
  type = string
}

variable "isolated_subnet_cidr_a" {
  type = string
}

variable "isolated_subnet_cidr_c" {
  type = string
}

variable "domain_name" {
  type = string
}
