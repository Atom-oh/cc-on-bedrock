variable "name_prefix" {
  description = "Name tag prefix for resources this module creates"
  type        = string
}

variable "vpc_id" {
  description = "Existing VPC ID (this module never creates a VPC)"
  type        = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnets with NAT egress (compute, Fargate, endpoints)"
  type        = list(string)
}

variable "isolated_subnet_ids" {
  type = list(string)
}

variable "interface_endpoint_services" {
  description = "Interface endpoint service suffixes to create (e.g. \"ssm\", \"logs\"); omit any the VPC already has"
  type        = list(string)
}

variable "domain_name" {
  type = string
}
