###############################################################################
# Dashboard Module - EC2 ASG, ALB, CloudFront
# Equivalent to cdk/lib/05-dashboard-stack.ts
###############################################################################

data "aws_region" "current" {}

# ---- Security Groups ---------------------------------------------------------
resource "aws_security_group" "alb" {
  name_prefix = "cc-dashboard-alb-"
  description = "Dashboard ALB SG"
  vpc_id      = var.vpc_id

  # CloudFront managed prefix list (region-specific)
  ingress {
    description     = "Allow CloudFront"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [var.cloudfront_prefix_list_id]
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

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 30
      volume_type = "gp3"
      encrypted   = true
    }
  }

  user_data = base64encode(<<-USERDATA
#!/bin/bash
set -euo pipefail

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs

# Install PM2
npm install -g pm2

# TODO: Deploy Next.js app from S3/CodeDeploy
# For now, create placeholder
mkdir -p /opt/dashboard
cd /opt/dashboard

cat > server.js << INNEREOF
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>CC-on-Bedrock Dashboard</h1><p>Next.js app will be deployed here.</p>');
  }
});
server.listen(3000, () => console.log('Dashboard running on port 3000'));
INNEREOF

pm2 start server.js --name dashboard
pm2 startup
pm2 save
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

  tag {
    key                 = "Name"
    value               = "cc-dashboard"
    propagate_at_launch = true
  }
}

# ---- CloudFront Distribution -------------------------------------------------
resource "aws_cloudfront_distribution" "this" {
  comment = "CC-on-Bedrock Dashboard (ADR-016 split)"
  enabled = true
  aliases = var.cloudfront_cert_arn != "" ? ["${var.dashboard_subdomain}.${var.domain_name}"] : []

  web_acl_id = var.web_acl_arn != "" ? var.web_acl_arn : null

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
    cloudfront_default_certificate = var.cloudfront_cert_arn == ""
    acm_certificate_arn            = var.cloudfront_cert_arn != "" ? var.cloudfront_cert_arn : null
    ssl_support_method             = var.cloudfront_cert_arn != "" ? "sni-only" : null
    minimum_protocol_version       = var.cloudfront_cert_arn != "" ? "TLSv1.2_2021" : null
  }

  tags = { Name = "cc-dashboard-cloudfront" }
}

# ---- Route 53 Record ---------------------------------------------------------
resource "aws_route53_record" "dashboard" {
  zone_id = var.hosted_zone_id
  name    = "${var.dashboard_subdomain}.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
