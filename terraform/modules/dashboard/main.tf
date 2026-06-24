###############################################################################
# Dashboard Module - EC2 ASG, ALB, CloudFront
# Dashboard hosting module
###############################################################################

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  dashboard_domain = "${var.dashboard_subdomain}.${var.domain_name}"
  runtime_env = {
    AWS_ACCOUNT_ID        = data.aws_caller_identity.current.account_id
    AWS_REGION            = data.aws_region.current.name
    COGNITO_CLI_CLIENT_ID = var.cognito_cli_public_client_id
    COGNITO_CLIENT_ID     = var.user_pool_client_id
    COGNITO_ISSUER        = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${var.user_pool_id}"
    COGNITO_USER_POOL_ID  = var.user_pool_id
    # DevEnv edge auth reads the dashboard session cookie, then strips NextAuth
    # cookies before forwarding to user-controlled origins.
    COOKIE_DOMAIN               = ".${var.domain_name}"
    DASHBOARD_URL               = "https://${local.dashboard_domain}"
    DEV_SUBDOMAIN               = var.dev_subdomain
    DNS_FIREWALL_RULE_GROUP_ID  = var.dns_firewall_rule_group_id
    DOMAIN_NAME                 = var.domain_name
    INSTANCE_TABLE              = var.instance_table_name
    LAUNCH_TEMPLATE             = var.devenv_launch_template_name
    NEXTAUTH_URL                = "https://${local.dashboard_domain}"
    NEXT_PUBLIC_DEV_SUBDOMAIN   = var.dev_subdomain
    NEXT_PUBLIC_DOMAIN_NAME     = var.domain_name
    OTEL_EXPORTER_OTLP_ENDPOINT = var.otel_collector_endpoint
    PRIVATE_SUBNET_IDS          = join(",", var.private_subnet_ids)
    ROUTING_TABLE               = var.routing_table_name
    SG_DEVENV_LOCKED            = var.devenv_sg_locked_id
    SG_DEVENV_OPEN              = var.devenv_sg_open_id
    SG_DEVENV_RESTRICTED        = var.devenv_sg_restricted_id
    VPC_ID                      = var.vpc_id
  }
  runtime_env_file = join("\n", [for key, value in local.runtime_env : "${key}=${value}"])
}

# ---- Security Groups ---------------------------------------------------------
resource "aws_security_group" "alb" {
  name_prefix = "cc-dashboard-alb-"
  description = "Dashboard ALB SG"
  vpc_id      = var.vpc_id

  # CloudFront managed prefix list for ap-northeast-2
  ingress {
    description     = "Allow CloudFront"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = ["pl-22a6434b"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-dashboard-alb-sg" }
}

resource "aws_security_group" "ec2" {
  name_prefix = "cc-dashboard-ec2-"
  description = "Dashboard EC2 SG"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-dashboard-ec2-sg" }
}

# ---- ALB ---------------------------------------------------------------------
resource "aws_lb" "this" {
  name               = "cc-dashboard-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  tags = { Name = "cc-dashboard-alb" }
}

resource "aws_lb_target_group" "this" {
  name     = "cc-dashboard-tg"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path     = "/api/health"
    interval = 30
  }

  tags = { Name = "cc-dashboard-tg" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.dashboard_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

# ---- Launch Template + ASG ---------------------------------------------------
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_launch_template" "this" {
  name_prefix   = "cc-dashboard-"
  image_id      = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = var.instance_type

  iam_instance_profile {
    name = var.dashboard_ec2_instance_profile_name
  }

  vpc_security_group_ids = [aws_security_group.ec2.id]

  # IMDSv2 required; hop limit 2 so the Docker container (one extra hop) can reach
  # IMDS and assume the dashboard EC2 instance role for AWS SDK calls.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 30
      volume_type = "gp3"
      encrypted   = true
    }
  }

  # Deploy the real Next.js dashboard from the Terraform-managed ECR repository.
  # NEXTAUTH_SECRET is fetched from SSM at boot so it is not embedded in user_data
  # or the launch template. AWS creds come from the instance role.
  user_data = base64encode(<<-USERDATA
#!/bin/bash
set -euo pipefail

REGION="${data.aws_region.current.name}"
ACCOUNT="${data.aws_caller_identity.current.account_id}"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
IMAGE="${var.dashboard_ecr_repository_url}:${var.dashboard_image_tag}"
NEXTAUTH_SECRET_PARAM="${var.nextauth_secret_ssm_parameter_arn}"

retry() {
  local delay=5
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then
      return 0
    fi
    sleep "$delay"
    delay=$((delay * 2))
  done
  "$@"
}

login_ecr() {
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
}

# Docker (AL2023)
dnf install -y docker
systemctl enable --now docker

# Runtime env written from TF runtime_env. Secret values are fetched below.
# Next.js standalone server binds 0.0.0.0:3000.
umask 077
cat > /opt/dashboard.env << 'ENVEOF'
${local.runtime_env_file}
ENVEOF
NEXTAUTH_SECRET="$(retry aws ssm get-parameter --name "$NEXTAUTH_SECRET_PARAM" --with-decryption --query 'Parameter.Value' --output text --region "$REGION")"
{
  echo "NODE_ENV=production"
  echo "PORT=3000"
  echo "HOSTNAME=0.0.0.0"
  printf 'NEXTAUTH_SECRET=%s\n' "$NEXTAUTH_SECRET"
} >> /opt/dashboard.env
chmod 600 /opt/dashboard.env

# ECR auth + pull + run
retry login_ecr
retry docker pull "$IMAGE"
docker rm -f dashboard 2>/dev/null || true
docker run -d --name dashboard --restart always --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 -p 3000:3000 --env-file /opt/dashboard.env "$IMAGE"
USERDATA
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "cc-dashboard" }
  }
}

resource "aws_autoscaling_group" "this" {
  name                = "cc-dashboard-asg"
  min_size            = 1
  max_size            = 2
  desired_capacity    = 1
  vpc_zone_identifier = var.private_subnet_ids
  health_check_type   = "ELB"
  target_group_arns   = [aws_lb_target_group.this.arn]

  launch_template {
    id      = aws_launch_template.this.id
    version = "$Latest"
  }

  # Roll instances when the launch template changes (new image / runtime env):
  # bring up a fresh instance, wait for ELB health, then terminate the old one.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 100
      instance_warmup        = 300
    }
  }

  tag {
    key                 = "Name"
    value               = "cc-dashboard"
    propagate_at_launch = true
  }
}

# ---- CloudFront Certificate --------------------------------------------------
resource "aws_acm_certificate" "cloudfront" {
  provider          = aws.us_east_1
  domain_name       = local.dashboard_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "cc-on-bedrock-dashboard-cloudfront" }
}

resource "aws_route53_record" "cloudfront_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for r in aws_route53_record.cloudfront_cert_validation : r.fqdn]
}

# ---- CloudFront Distribution -------------------------------------------------
resource "aws_cloudfront_distribution" "this" {
  comment = "CC-on-Bedrock Dashboard"
  enabled = true
  aliases = [local.dashboard_domain]

  origin {
    domain_name = aws_lb.this.dns_name
    origin_id   = "dashboard-alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-Custom-Secret"
      value = var.cloudfront_secret_value
    }
  }

  default_cache_behavior {
    target_origin_id       = "dashboard-alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    # CachingDisabled managed policy
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    # AllViewer origin request policy
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cloudfront.certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  tags = { Name = "cc-dashboard-cloudfront" }
}

# ---- Route 53 Record ---------------------------------------------------------
resource "aws_route53_record" "dashboard" {
  zone_id         = var.hosted_zone_id
  name            = local.dashboard_domain
  type            = "A"
  allow_overwrite = true

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
