###############################################################################
# Network Module - existing VPC (bring-your-own), VPC Endpoints, Route 53
#
# The VPC, subnets, route tables, IGW/NAT and gateway endpoints are owned
# outside this stack (shared demo/product VPC) and passed in by ID. This module
# never creates a VPC; it only adds what cc-on-bedrock needs inside it.
###############################################################################

data "aws_region" "current" {}

data "aws_vpc" "this" {
  id = var.vpc_id
}

data "aws_subnet" "private" {
  for_each = toset(var.private_subnet_ids)
  id       = each.value
}

locals {
  dns_firewall_managed_domain_lists = {
    malware          = { id = "rslvr-fdl-6301b5257e0c4210", priority = 100 }
    botnet           = { id = "rslvr-fdl-e8d1e969ad484741", priority = 200 }
    guardduty        = { id = "rslvr-fdl-19615996f5c5490f", priority = 300 }
    aggregate_threat = { id = "rslvr-fdl-1997a3cdd61a4f2a", priority = 400 }
  }
}

# ---- VPC Endpoint Security Group ---------------------------------------------
resource "aws_security_group" "vpc_endpoints" {
  count = length(var.interface_endpoint_services) > 0 ? 1 : 0

  name_prefix = "cc-vpce-"
  description = "Allow HTTPS from VPC for interface VPC endpoints"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.this.cidr_block]
  }

  tags = { Name = "${var.name_prefix}-vpce-sg" }
}

# ---- Interface VPC Endpoints -------------------------------------------------
# Only services the VPC does not already expose: a second endpoint with private
# DNS for the same service in one VPC fails (conflicting DNS domain).
resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoint_services)

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]

  tags = { Name = "${var.name_prefix}-${each.value}" }
}

# ---- Route 53 public hosted zone (shared, looked up) ---------------------------
# The apex zone carries records for other projects; this stack only adds records.
data "aws_route53_zone" "this" {
  name         = var.domain_name
  private_zone = false
}

# ---- Route 53 Resolver DNS Firewall -----------------------------------------
# Managed threat lists are region-specific IDs. These IDs match ap-northeast-2,
# the deployment region supported by this Terraform root today, and preserve the
# CDK-era DLP security layer for restricted/locked DevEnv tiers.
resource "aws_route53_resolver_firewall_rule_group" "dns_firewall" {
  name = "cc-on-bedrock-dns-firewall"

  tags = { Name = "cc-on-bedrock-dns-firewall" }
}

resource "aws_route53_resolver_firewall_rule" "managed_threat" {
  for_each = local.dns_firewall_managed_domain_lists

  name                    = "cc-on-bedrock-${each.key}"
  action                  = "BLOCK"
  block_response          = "NXDOMAIN"
  firewall_domain_list_id = each.value.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.dns_firewall.id
  priority                = each.value.priority
}

resource "aws_route53_resolver_firewall_rule_group_association" "dns_firewall" {
  name                   = "cc-on-bedrock-dns-firewall"
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.dns_firewall.id
  priority               = 101
  vpc_id                 = var.vpc_id

  tags = { Name = "cc-on-bedrock-dns-firewall" }
}
