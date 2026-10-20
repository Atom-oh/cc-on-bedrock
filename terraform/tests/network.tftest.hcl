mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { name = "ap-northeast-2" }
  }
  mock_data "aws_vpc" {
    defaults = {
      cidr_block           = "10.50.0.0/16"
      enable_dns_support   = true
      enable_dns_hostnames = true
    }
  }
  mock_data "aws_subnet" {
    defaults = { vpc_id = "vpc-0123456789abcdef0" }
  }
}

override_data {
  target = data.aws_subnet.existing["subnet-00000000000000001"]
  values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "ap-northeast-2a", cidr_block = "10.50.1.0/24" }
}
override_data {
  target = data.aws_subnet.existing["subnet-00000000000000002"]
  values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "ap-northeast-2c", cidr_block = "10.50.2.0/24" }
}
override_data {
  target = data.aws_subnet.existing["subnet-00000000000000003"]
  values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "ap-northeast-2a", cidr_block = "10.50.16.0/20" }
}
override_data {
  target = data.aws_subnet.existing["subnet-00000000000000004"]
  values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "ap-northeast-2c", cidr_block = "10.50.32.0/20" }
}
override_data {
  target = data.aws_subnet.existing["subnet-00000000000000005"]
  values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "ap-northeast-2a", cidr_block = "10.50.100.0/23" }
}
override_data {
  target = data.aws_subnet.existing["subnet-00000000000000006"]
  values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "ap-northeast-2c", cidr_block = "10.50.102.0/23" }
}

variables {
  vpc_id                 = "vpc-0123456789abcdef0"
  public_subnet_ids      = ["subnet-00000000000000001", "subnet-00000000000000002"]
  private_subnet_ids     = ["subnet-00000000000000003", "subnet-00000000000000004"]
  isolated_subnet_ids    = ["subnet-00000000000000005", "subnet-00000000000000006"]
  vpc_name               = "test-dedicated"
  vpc_cidr               = "10.0.0.0/16"
  public_subnet_cidr_a   = "10.0.1.0/24"
  public_subnet_cidr_c   = "10.0.2.0/24"
  private_subnet_cidr_a  = "10.0.16.0/20"
  private_subnet_cidr_c  = "10.0.32.0/20"
  isolated_subnet_cidr_a = "10.0.100.0/23"
  isolated_subnet_cidr_c = "10.0.102.0/23"
  domain_name            = "example.com"
}

run "existing_vpc_uses_actual_network" {
  command = plan
  module { source = "./modules/network" }

  assert {
    condition     = output.vpc_id == var.vpc_id && output.vpc_cidr == "10.50.0.0/16"
    error_message = "Existing VPC identity and CIDR must come from AWS."
  }
  assert {
    condition     = output.public_subnet_ids == var.public_subnet_ids && output.private_subnet_ids == var.private_subnet_ids && output.isolated_subnet_ids == var.isolated_subnet_ids
    error_message = "Selected subnet order and IDs must propagate to consumers."
  }
  assert {
    condition     = tolist(output.private_subnet_cidrs) == tolist(["10.50.16.0/20", "10.50.32.0/20"])
    error_message = "OTLP egress must use the selected subnets' CIDRs, not dedicated-network defaults."
  }
  assert {
    condition     = length(aws_vpc.this) == 0 && length(aws_subnet.public_a) == 0 && length(aws_nat_gateway.a) == 0 && length(aws_vpc_endpoint.interface) == 0 && length(aws_vpc_endpoint.s3) == 0
    error_message = "The application must not create shared-network infrastructure."
  }
  assert {
    condition     = aws_route53_resolver_firewall_rule_group_association.dns_firewall.vpc_id == var.vpc_id
    error_message = "DNS Firewall must follow the selected VPC."
  }
}

run "dedicated_vpc_remains_default" {
  command = plan
  module { source = "./modules/network" }
  variables {
    vpc_id              = null
    public_subnet_ids   = []
    private_subnet_ids  = []
    isolated_subnet_ids = []
  }
  assert {
    condition     = length(aws_vpc.this) == 1 && length(aws_nat_gateway.a) == 1 && length(aws_nat_gateway.c) == 1 && length(aws_vpc_endpoint.interface) == 7 && length(aws_vpc_endpoint.s3) == 1
    error_message = "Dedicated networking must retain its VPC, NAT and endpoints."
  }
  assert {
    condition     = output.vpc_cidr == "10.0.0.0/16" && tolist(output.private_subnet_cidrs) == tolist(["10.0.16.0/20", "10.0.32.0/20"])
    error_message = "Dedicated networking must retain configured CIDRs."
  }
}

run "reject_subnet_in_another_vpc" {
  command = plan
  module { source = "./modules/network" }
  override_data {
    target = data.aws_subnet.existing["subnet-00000000000000001"]
    values = {
      vpc_id            = "vpc-11111111111111111"
      availability_zone = "ap-northeast-2a"
      cidr_block        = "10.50.1.0/24"
    }
  }
  expect_failures = [data.aws_subnet.existing]
}

run "reject_single_az_public_subnets" {
  command = plan
  module { source = "./modules/network" }
  override_data {
    target = data.aws_subnet.existing["subnet-00000000000000002"]
    values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "ap-northeast-2a", cidr_block = "10.50.2.0/24" }
  }
  expect_failures = [output.public_subnet_ids]
}

run "reject_disabled_dns" {
  command = plan
  module { source = "./modules/network" }
  override_data {
    target = data.aws_vpc.existing[0]
    values = {
      cidr_block           = "10.50.0.0/16"
      enable_dns_support   = false
      enable_dns_hostnames = true
    }
  }
  expect_failures = [data.aws_vpc.existing]
}

run "reject_secondary_cidr_subnet" {
  command = plan
  module { source = "./modules/network" }
  override_data {
    target = data.aws_subnet.existing["subnet-00000000000000003"]
    values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "ap-northeast-2a", cidr_block = "10.60.16.0/20" }
  }
  expect_failures = [data.aws_subnet.existing]
}

run "reject_overlapping_subnet_groups" {
  command = plan
  module { source = "./modules/network" }
  variables {
    private_subnet_ids = ["subnet-00000000000000001", "subnet-00000000000000002"]
  }
  expect_failures = [data.aws_vpc.existing]
}

run "reject_subnet_ids_without_vpc" {
  command = plan
  module { source = "./modules/network" }
  variables {
    vpc_id = null
  }
  expect_failures = [aws_vpc.this]
}
