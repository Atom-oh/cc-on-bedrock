output "vpc_id" {
  value = data.aws_vpc.this.id
}

output "vpc_cidr" {
  value = data.aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = var.public_subnet_ids
}

output "private_subnet_ids" {
  value = var.private_subnet_ids
}

output "private_subnet_cidrs" {
  value = [for id in var.private_subnet_ids : data.aws_subnet.private[id].cidr_block]
}

output "isolated_subnet_ids" {
  value = var.isolated_subnet_ids
}

output "hosted_zone_id" {
  value = data.aws_route53_zone.this.zone_id
}

output "hosted_zone_name" {
  value = data.aws_route53_zone.this.name
}

output "dns_firewall_rule_group_id" {
  value = aws_route53_resolver_firewall_rule_group.dns_firewall.id
}

output "vpc_endpoint_security_group_ids" {
  value = aws_security_group.vpc_endpoints[*].id
}
