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

# ---- Route 53 Private Hosted Zone -------------------------------------------
resource "aws_route53_zone" "this" {
  name = var.domain_name
}
