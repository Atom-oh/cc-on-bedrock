mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { name = "ap-northeast-2" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  vpc_id                      = "vpc-0123456789abcdef0"
  vpc_cidr                    = "10.50.0.0/16"
  kms_key_arn                 = "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-1111-1111-1111-111111111111"
  nginx_security_group_id     = "sg-0123456789abcdef0"
  otel_collector_subnet_cidrs = ["10.50.2.0/24", "10.50.3.0/24"]
}

run "nginx_ingress_stays_narrow" {
  command = plan
  module { source = "./modules/ec2-devenv" }
  variables {
    use_nginx_security_group = true
  }

  assert {
    condition = alltrue([
      for group in [aws_security_group.open, aws_security_group.restricted, aws_security_group.locked] :
      length(group.ingress) == 1 && alltrue([
        for rule in group.ingress :
        rule.from_port == 1024 && rule.to_port == 65535 &&
        rule.security_groups == toset([var.nginx_security_group_id]) &&
        length(coalesce(rule.cidr_blocks, [])) == 0
      ])
    ])
    error_message = "Every tier must allow application ports only from the Nginx security group."
  }
}

run "explicit_vpc_fallback_keeps_fixed_ports" {
  command = plan
  module { source = "./modules/ec2-devenv" }
  variables {
    use_nginx_security_group = false
    nginx_security_group_id  = ""
  }

  assert {
    condition = alltrue([
      for group in [aws_security_group.open, aws_security_group.restricted, aws_security_group.locked] :
      toset([for rule in group.ingress : rule.from_port]) == toset([8080, 3000, 8000]) &&
      alltrue([
        for rule in group.ingress :
        rule.from_port == rule.to_port &&
        toset(rule.cidr_blocks) == toset([var.vpc_cidr]) &&
        length(coalesce(rule.security_groups, toset([]))) == 0
      ])
    ])
    error_message = "Explicit fallback must retain only the three fixed VPC-scoped ports."
  }
}
