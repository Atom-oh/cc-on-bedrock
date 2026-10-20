###############################################################################
# Network Module - VPC, Subnets, NAT Gateways, VPC Endpoints, Route 53
# Network module
###############################################################################

data "aws_region" "current" {}

locals {
  azs = ["${data.aws_region.current.name}a", "${data.aws_region.current.name}c"]
  dns_firewall_managed_domain_lists = {
    malware          = { id = "rslvr-fdl-6301b5257e0c4210", priority = 100 }
    botnet           = { id = "rslvr-fdl-e8d1e969ad484741", priority = 200 }
    guardduty        = { id = "rslvr-fdl-19615996f5c5490f", priority = 300 }
    aggregate_threat = { id = "rslvr-fdl-1997a3cdd61a4f2a", priority = 400 }
  }
}

# ---- VPC ---------------------------------------------------------------------
resource "aws_vpc" "this" {
  count = local.create_managed_network ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.vpc_name }

  lifecycle {
    precondition {
      condition     = local.use_existing_vpc || length(local.existing_subnet_ids) == 0
      error_message = "Subnet ID inputs require vpc_id. Leave all subnet ID lists empty when creating a VPC."
    }
  }
}

# ---- Internet Gateway --------------------------------------------------------
resource "aws_internet_gateway" "this" {
  count  = local.create_managed_network ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${var.vpc_name}-igw" }
}

# ---- Public Subnets ----------------------------------------------------------
resource "aws_subnet" "public_a" {
  count                   = local.create_managed_network ? 1 : 0
  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = var.public_subnet_cidr_a
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.vpc_name}-Public-A" }
}

resource "aws_subnet" "public_c" {
  count                   = local.create_managed_network ? 1 : 0
  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = var.public_subnet_cidr_c
  availability_zone       = local.azs[1]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.vpc_name}-Public-C" }
}

resource "aws_route_table" "public" {
  count  = local.create_managed_network ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${var.vpc_name}-public-rt" }
}

resource "aws_route" "public_internet" {
  count                  = local.create_managed_network ? 1 : 0
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this[0].id
}

resource "aws_route_table_association" "public_a" {
  count          = local.create_managed_network ? 1 : 0
  subnet_id      = aws_subnet.public_a[0].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table_association" "public_c" {
  count          = local.create_managed_network ? 1 : 0
  subnet_id      = aws_subnet.public_c[0].id
  route_table_id = aws_route_table.public[0].id
}

# ---- NAT Gateways (one per AZ) ----------------------------------------------
resource "aws_eip" "nat_a" {
  count  = local.create_managed_network ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.vpc_name}-nat-a" }
}

resource "aws_eip" "nat_c" {
  count  = local.create_managed_network ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.vpc_name}-nat-c" }
}

resource "aws_nat_gateway" "a" {
  count         = local.create_managed_network ? 1 : 0
  allocation_id = aws_eip.nat_a[0].id
  subnet_id     = aws_subnet.public_a[0].id
  tags          = { Name = "${var.vpc_name}-nat-a" }
}

resource "aws_nat_gateway" "c" {
  count         = local.create_managed_network ? 1 : 0
  allocation_id = aws_eip.nat_c[0].id
  subnet_id     = aws_subnet.public_c[0].id
  tags          = { Name = "${var.vpc_name}-nat-c" }
}

# ---- Private Subnets (PRIVATE_WITH_EGRESS) -----------------------------------
resource "aws_subnet" "private_a" {
  count             = local.create_managed_network ? 1 : 0
  vpc_id            = aws_vpc.this[0].id
  cidr_block        = var.private_subnet_cidr_a
  availability_zone = local.azs[0]
  tags              = { Name = "${var.vpc_name}-Private-A" }
}

resource "aws_subnet" "private_c" {
  count             = local.create_managed_network ? 1 : 0
  vpc_id            = aws_vpc.this[0].id
  cidr_block        = var.private_subnet_cidr_c
  availability_zone = local.azs[1]
  tags              = { Name = "${var.vpc_name}-Private-C" }
}

resource "aws_route_table" "private_a" {
  count  = local.create_managed_network ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${var.vpc_name}-private-rt-a" }
}

resource "aws_route_table" "private_c" {
  count  = local.create_managed_network ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${var.vpc_name}-private-rt-c" }
}

resource "aws_route" "private_nat_a" {
  count                  = local.create_managed_network ? 1 : 0
  route_table_id         = aws_route_table.private_a[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.a[0].id
}

resource "aws_route" "private_nat_c" {
  count                  = local.create_managed_network ? 1 : 0
  route_table_id         = aws_route_table.private_c[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.c[0].id
}

resource "aws_route_table_association" "private_a" {
  count          = local.create_managed_network ? 1 : 0
  subnet_id      = aws_subnet.private_a[0].id
  route_table_id = aws_route_table.private_a[0].id
}

resource "aws_route_table_association" "private_c" {
  count          = local.create_managed_network ? 1 : 0
  subnet_id      = aws_subnet.private_c[0].id
  route_table_id = aws_route_table.private_c[0].id
}

# ---- Isolated Subnets (PRIVATE_ISOLATED) -------------------------------------
resource "aws_subnet" "isolated_a" {
  count             = local.create_managed_network ? 1 : 0
  vpc_id            = aws_vpc.this[0].id
  cidr_block        = var.isolated_subnet_cidr_a
  availability_zone = local.azs[0]
  tags              = { Name = "${var.vpc_name}-Isolated-A" }
}

resource "aws_subnet" "isolated_c" {
  count             = local.create_managed_network ? 1 : 0
  vpc_id            = aws_vpc.this[0].id
  cidr_block        = var.isolated_subnet_cidr_c
  availability_zone = local.azs[1]
  tags              = { Name = "${var.vpc_name}-Isolated-C" }
}

resource "aws_route_table" "isolated" {
  count  = local.create_managed_network ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${var.vpc_name}-isolated-rt" }
}

resource "aws_route_table_association" "isolated_a" {
  count          = local.create_managed_network ? 1 : 0
  subnet_id      = aws_subnet.isolated_a[0].id
  route_table_id = aws_route_table.isolated[0].id
}

resource "aws_route_table_association" "isolated_c" {
  count          = local.create_managed_network ? 1 : 0
  subnet_id      = aws_subnet.isolated_c[0].id
  route_table_id = aws_route_table.isolated[0].id
}

# ---- VPC Endpoint Security Group ---------------------------------------------
resource "aws_security_group" "vpc_endpoints" {
  count       = local.create_managed_network ? 1 : 0
  name_prefix = "cc-vpce-"
  description = "Allow HTTPS from VPC for interface VPC endpoints"
  vpc_id      = aws_vpc.this[0].id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "${var.vpc_name}-vpce-sg" }
}

# ---- Interface VPC Endpoints -------------------------------------------------
locals {
  interface_endpoints = {
    ssm             = "com.amazonaws.${data.aws_region.current.name}.ssm"
    ssm_messages    = "com.amazonaws.${data.aws_region.current.name}.ssmmessages"
    ec2_messages    = "com.amazonaws.${data.aws_region.current.name}.ec2messages"
    ecr_api         = "com.amazonaws.${data.aws_region.current.name}.ecr.api"
    ecr_dkr         = "com.amazonaws.${data.aws_region.current.name}.ecr.dkr"
    bedrock_runtime = "com.amazonaws.${data.aws_region.current.name}.bedrock-runtime"
    cloudwatch_logs = "com.amazonaws.${data.aws_region.current.name}.logs"
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.create_managed_network ? local.interface_endpoints : {}

  vpc_id              = aws_vpc.this[0].id
  service_name        = each.value
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [aws_subnet.private_a[0].id, aws_subnet.private_c[0].id]
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]

  tags = { Name = "${var.vpc_name}-${each.key}" }
}

# ---- Gateway VPC Endpoint (S3) -----------------------------------------------
resource "aws_vpc_endpoint" "s3" {
  count             = local.create_managed_network ? 1 : 0
  vpc_id            = aws_vpc.this[0].id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = [
    aws_route_table.public[0].id,
    aws_route_table.private_a[0].id,
    aws_route_table.private_c[0].id,
    aws_route_table.isolated[0].id,
  ]

  tags = { Name = "${var.vpc_name}-s3" }
}

# ---- Route 53 Public Hosted Zone --------------------------------------------
resource "aws_route53_zone" "this" {
  name = var.domain_name
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
  vpc_id                 = local.vpc_id

  tags = { Name = "cc-on-bedrock-dns-firewall" }
}
