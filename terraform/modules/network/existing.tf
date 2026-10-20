# Shared networking remains owned by its original infrastructure stack.
# This module reads it and manages only the application DNS/firewall resources.
locals {
  use_existing_vpc = var.vpc_id != null
  vpc_id           = local.use_existing_vpc ? data.aws_vpc.existing[0].id : aws_vpc.this[0].id
  vpc_cidr         = local.use_existing_vpc ? data.aws_vpc.existing[0].cidr_block : aws_vpc.this[0].cidr_block
  subnet_groups = {
    public   = var.public_subnet_ids
    private  = var.private_subnet_ids
    isolated = var.isolated_subnet_ids
  }
  existing_subnet_ids = concat(var.public_subnet_ids, var.private_subnet_ids, var.isolated_subnet_ids)
}

data "aws_vpc" "existing" {
  count = local.use_existing_vpc ? 1 : 0
  id    = var.vpc_id

  lifecycle {
    precondition {
      condition     = alltrue([for ids in values(local.subnet_groups) : length(ids) >= 2])
      error_message = "An existing VPC requires public, private and isolated subnet IDs, each across at least two AZs."
    }
    precondition {
      condition     = length(distinct(local.existing_subnet_ids)) == length(local.existing_subnet_ids)
      error_message = "Public, private and isolated subnet groups must not overlap."
    }
    postcondition {
      condition     = self.enable_dns_support && self.enable_dns_hostnames
      error_message = "The existing VPC must enable DNS support and DNS hostnames."
    }
  }
}

data "aws_subnet" "existing" {
  for_each = local.use_existing_vpc ? toset(local.existing_subnet_ids) : toset([])
  id       = each.value

  lifecycle {
    postcondition {
      condition     = self.vpc_id == var.vpc_id
      error_message = "Every selected subnet must belong to vpc_id."
    }
    postcondition {
      condition = (
        tonumber(split("/", self.cidr_block)[1]) >= tonumber(split("/", data.aws_vpc.existing[0].cidr_block)[1]) &&
        cidrhost("${split("/", self.cidr_block)[0]}/${split("/", data.aws_vpc.existing[0].cidr_block)[1]}", 0) == cidrhost(data.aws_vpc.existing[0].cidr_block, 0)
      )
      error_message = "Selected subnets must be inside the primary VPC CIDR used by the application security rules."
    }
  }
}
