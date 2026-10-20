output "vpc_id" {
  value = local.vpc_id
}

output "vpc_cidr" {
  value = local.vpc_cidr
}

output "public_subnet_ids" {
  value = local.use_existing_vpc ? var.public_subnet_ids : [aws_subnet.public_a[0].id, aws_subnet.public_c[0].id]

  precondition {
    condition     = local.use_existing_vpc ? length(distinct([for id in var.public_subnet_ids : data.aws_subnet.existing[id].availability_zone])) >= 2 : true
    error_message = "Public subnets must span at least two availability zones."
  }
}

output "private_subnet_ids" {
  value = local.use_existing_vpc ? var.private_subnet_ids : [aws_subnet.private_a[0].id, aws_subnet.private_c[0].id]

  precondition {
    condition     = local.use_existing_vpc ? length(distinct([for id in var.private_subnet_ids : data.aws_subnet.existing[id].availability_zone])) >= 2 : true
    error_message = "Private subnets must span at least two availability zones."
  }
}

output "isolated_subnet_ids" {
  value = local.use_existing_vpc ? var.isolated_subnet_ids : [aws_subnet.isolated_a[0].id, aws_subnet.isolated_c[0].id]

  precondition {
    condition     = local.use_existing_vpc ? length(distinct([for id in var.isolated_subnet_ids : data.aws_subnet.existing[id].availability_zone])) >= 2 : true
    error_message = "Isolated subnets must span at least two availability zones."
  }
}

output "private_subnet_cidrs" {
  description = "Actual private subnet CIDRs used to scope DevEnv OTLP egress."
  value       = local.use_existing_vpc ? [for id in var.private_subnet_ids : data.aws_subnet.existing[id].cidr_block] : [aws_subnet.private_a[0].cidr_block, aws_subnet.private_c[0].cidr_block]
}

output "hosted_zone_id" {
  value = aws_route53_zone.this.zone_id
}

output "hosted_zone_name" {
  value = aws_route53_zone.this.name
}

output "dns_firewall_rule_group_id" {
  value = aws_route53_resolver_firewall_rule_group.dns_firewall.id
}
