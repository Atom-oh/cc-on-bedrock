###############################################################################
# Network Module - VPC, Subnets, NAT Gateways, VPC Endpoints, Route 53
# Equivalent to cdk/lib/01-network-stack.ts
###############################################################################

data "aws_region" "current" {}

locals {
  azs = ["${data.aws_region.current.name}a", "${data.aws_region.current.name}c"]
}

# ---- VPC ---------------------------------------------------------------------
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.vpc_name }
}

# ---- Internet Gateway --------------------------------------------------------
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.vpc_name}-igw" }
}

# ---- Public Subnets ----------------------------------------------------------
resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidr_a
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.vpc_name}-Public-A" }
}

resource "aws_subnet" "public_c" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidr_c
  availability_zone       = local.azs[1]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.vpc_name}-Public-C" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.vpc_name}-public-rt" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_c" {
  subnet_id      = aws_subnet.public_c.id
  route_table_id = aws_route_table.public.id
}

# ---- NAT Gateways (one per AZ, matching CDK natGateways: 2) -----------------
resource "aws_eip" "nat_a" {
  domain = "vpc"
  tags   = { Name = "${var.vpc_name}-nat-a" }
}

resource "aws_eip" "nat_c" {
  domain = "vpc"
  tags   = { Name = "${var.vpc_name}-nat-c" }
}

resource "aws_nat_gateway" "a" {
  allocation_id = aws_eip.nat_a.id
  subnet_id     = aws_subnet.public_a.id
  tags          = { Name = "${var.vpc_name}-nat-a" }
}

resource "aws_nat_gateway" "c" {
  allocation_id = aws_eip.nat_c.id
  subnet_id     = aws_subnet.public_c.id
  tags          = { Name = "${var.vpc_name}-nat-c" }
}

# ---- Private Subnets (PRIVATE_WITH_EGRESS) -----------------------------------
resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidr_a
  availability_zone = local.azs[0]
  tags              = { Name = "${var.vpc_name}-Private-A" }
}

resource "aws_subnet" "private_c" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidr_c
  availability_zone = local.azs[1]
  tags              = { Name = "${var.vpc_name}-Private-C" }
}

resource "aws_route_table" "private_a" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.vpc_name}-private-rt-a" }
}

resource "aws_route_table" "private_c" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.vpc_name}-private-rt-c" }
}

resource "aws_route" "private_nat_a" {
  route_table_id         = aws_route_table.private_a.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.a.id
}

resource "aws_route" "private_nat_c" {
  route_table_id         = aws_route_table.private_c.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.c.id
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private_a.id
}

resource "aws_route_table_association" "private_c" {
  subnet_id      = aws_subnet.private_c.id
  route_table_id = aws_route_table.private_c.id
}

# ---- Isolated Subnets (PRIVATE_ISOLATED) -------------------------------------
resource "aws_subnet" "isolated_a" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.isolated_subnet_cidr_a
  availability_zone = local.azs[0]
  tags              = { Name = "${var.vpc_name}-Isolated-A" }
}

resource "aws_subnet" "isolated_c" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.isolated_subnet_cidr_c
  availability_zone = local.azs[1]
  tags              = { Name = "${var.vpc_name}-Isolated-C" }
}

resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.vpc_name}-isolated-rt" }
}

resource "aws_route_table_association" "isolated_a" {
  subnet_id      = aws_subnet.isolated_a.id
  route_table_id = aws_route_table.isolated.id
}

resource "aws_route_table_association" "isolated_c" {
  subnet_id      = aws_subnet.isolated_c.id
  route_table_id = aws_route_table.isolated.id
}

# ---- VPC Endpoint Security Group ---------------------------------------------
resource "aws_security_group" "vpc_endpoints" {
  name_prefix = "cc-vpce-"
  description = "Allow HTTPS from VPC for interface VPC endpoints"
  vpc_id      = aws_vpc.this.id

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
  for_each = local.interface_endpoints

  vpc_id              = aws_vpc.this.id
  service_name        = each.value
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [aws_subnet.private_a.id, aws_subnet.private_c.id]
  security_group_ids  = [aws_security_group.vpc_endpoints.id]

  tags = { Name = "${var.vpc_name}-${each.key}" }
}

# ---- Gateway VPC Endpoint (S3) -----------------------------------------------
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = [
    aws_route_table.public.id,
    aws_route_table.private_a.id,
    aws_route_table.private_c.id,
    aws_route_table.isolated.id,
  ]

  tags = { Name = "${var.vpc_name}-s3" }
}

# ---- Route 53 Hosted Zone ---------------------------------------------------
# Mirrors CDK behavior: if hosted_zone_id is provided, look it up; otherwise
# create a brand-new public zone. (cdk/lib/01-network-stack.ts:77-87)
locals {
  create_hosted_zone = var.hosted_zone_id == ""
}

resource "aws_route53_zone" "this" {
  count = local.create_hosted_zone ? 1 : 0
  name  = var.domain_name
}

data "aws_route53_zone" "existing" {
  count   = local.create_hosted_zone ? 0 : 1
  zone_id = var.hosted_zone_id
}

locals {
  effective_hosted_zone_id   = local.create_hosted_zone ? aws_route53_zone.this[0].zone_id : data.aws_route53_zone.existing[0].zone_id
  effective_hosted_zone_name = local.create_hosted_zone ? aws_route53_zone.this[0].name : data.aws_route53_zone.existing[0].name
}

# ─── Route 53 DNS Firewall ───
# AWS managed domain list IDs for ap-northeast-2 (region-stable).
# CDK uses ID directly because the CFN schema rejects the ARN form (maxLength:64).
# Equivalent to cdk/lib/01-network-stack.ts:92-116.
locals {
  dns_firewall_domain_lists = {
    Malware         = "rslvr-fdl-6301b5257e0c4210"
    Botnet          = "rslvr-fdl-e8d1e969ad484741"
    AmazonGuardDuty = "rslvr-fdl-19615996f5c5490f"
    AggregateThreat = "rslvr-fdl-1997a3cdd61a4f2a"
  }
}

resource "aws_route53_resolver_firewall_rule_group" "this" {
  name = "cc-on-bedrock-dns-firewall"
}

resource "aws_route53_resolver_firewall_rule" "managed" {
  for_each = local.dns_firewall_domain_lists

  name                    = each.key
  action                  = "BLOCK"
  block_response          = "NXDOMAIN"
  firewall_domain_list_id = each.value
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.this.id
  priority                = (index(keys(local.dns_firewall_domain_lists), each.key) + 1) * 100
}

resource "aws_route53_resolver_firewall_rule_group_association" "this" {
  name                   = "cc-on-bedrock-dns-firewall"
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.this.id
  vpc_id                 = aws_vpc.this.id
  priority               = 101
}
