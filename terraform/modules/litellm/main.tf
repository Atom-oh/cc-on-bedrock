###############################################################################
# LiteLLM Module - Internal ALB, ASG, RDS PostgreSQL, Serverless Valkey, ECR
# Equivalent to cdk/lib/03-litellm-stack.ts
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ---- RDS Credentials (created here to match CDK's cross-stack pattern) -------
resource "random_password" "rds_password" {
  length  = 24
  special = false
}

resource "aws_secretsmanager_secret" "rds_credentials" {
  name = "cc-on-bedrock/rds-credentials"
}

resource "aws_secretsmanager_secret_version" "rds_credentials" {
  secret_id = aws_secretsmanager_secret.rds_credentials.id
  secret_string = jsonencode({
    username = "litellm_admin"
    password = random_password.rds_password.result
  })
}

# ---- ECR Repository ----------------------------------------------------------
resource "aws_ecr_repository" "litellm" {
  name                 = "cc-on-bedrock/litellm"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

# ---- Security Groups ---------------------------------------------------------
resource "aws_security_group" "alb" {
  name_prefix = "cc-litellm-alb-"
  description = "LiteLLM Internal ALB SG"
  vpc_id      = var.vpc_id

  ingress {
    description = "Allow from VPC"
    from_port   = 4000
    to_port     = 4000
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-litellm-alb-sg" }
}

resource "aws_security_group" "ec2" {
  name_prefix = "cc-litellm-ec2-"
  description = "LiteLLM EC2 SG"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow from ALB"
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-litellm-ec2-sg" }
}

resource "aws_security_group" "rds" {
  name_prefix = "cc-litellm-rds-"
  description = "RDS PostgreSQL SG"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow from LiteLLM EC2"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  tags = { Name = "cc-litellm-rds-sg" }
}

resource "aws_security_group" "valkey" {
  name_prefix = "cc-litellm-valkey-"
  description = "Serverless Valkey SG"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow from LiteLLM EC2"
    from_port       = 6380
    to_port         = 6380
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  tags = { Name = "cc-litellm-valkey-sg" }
}

# ---- Internal ALB ------------------------------------------------------------
resource "aws_lb" "this" {
  name               = "cc-litellm-internal"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.private_subnet_ids

  tags = { Name = "cc-litellm-internal-alb" }
}

resource "aws_lb_target_group" "this" {
  name     = "cc-litellm-tg"
  port     = 4000
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path                = "/health/liveness"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "cc-litellm-tg" }
}

resource "aws_lb_listener" "this" {
  load_balancer_arn = aws_lb.this.arn
  port              = 4000
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

# ---- RDS PostgreSQL ----------------------------------------------------------
resource "aws_db_subnet_group" "this" {
  name       = "cc-on-bedrock-litellm"
  subnet_ids = var.isolated_subnet_ids
  tags       = { Name = "cc-on-bedrock-litellm" }
}

resource "aws_db_instance" "this" {
  identifier     = "cc-on-bedrock-litellm"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.rds_instance_type

  db_name  = "litellm"
  username = "litellm_admin"
  password = random_password.rds_password.result

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period   = 7
  multi_az                  = false
  skip_final_snapshot       = false
  final_snapshot_identifier = "cc-litellm-final-snapshot"

  tags = { Name = "cc-on-bedrock-litellm" }
}

# ---- ElastiCache Serverless Valkey -------------------------------------------
resource "aws_elasticache_serverless_cache" "valkey" {
  engine = "valkey"
  name   = "cc-on-bedrock-valkey"

  subnet_ids         = var.isolated_subnet_ids
  security_group_ids = [aws_security_group.valkey.id]

  tags = { Name = "cc-on-bedrock-valkey" }
}

# ---- Launch Template + ASG ---------------------------------------------------
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_launch_template" "this" {
  name_prefix   = "cc-litellm-"
  image_id      = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = var.instance_type

  iam_instance_profile {
    name = var.litellm_ec2_instance_profile_name
  }

  vpc_security_group_ids = [aws_security_group.ec2.id]

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 50
      volume_type = "gp3"
      encrypted   = true
      kms_key_id  = var.kms_key_arn
    }
  }

  user_data = base64encode(<<-USERDATA
#!/bin/bash
set -euo pipefail
yum install -y docker jq
systemctl start docker
systemctl enable docker

# Login to ECR
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR_REGISTRY

# Pull and run LiteLLM
docker pull $ECR_REGISTRY/cc-on-bedrock/litellm:latest
docker run -d --restart always \
  --name litellm \
  -p 4000:4000 \
  -e AWS_DEFAULT_REGION=$REGION \
  -e LITELLM_MASTER_KEY_SECRET_ARN=${var.litellm_master_key_secret_arn} \
  -e RDS_CREDENTIALS_SECRET_ARN=${aws_secretsmanager_secret.rds_credentials.arn} \
  -e VALKEY_AUTH_SECRET_ARN=${var.valkey_auth_secret_arn} \
  -e REDIS_HOST=$(aws elasticache describe-serverless-caches --serverless-cache-name cc-on-bedrock-valkey --query 'ServerlessCaches[0].Endpoint.Address' --output text) \
  $ECR_REGISTRY/cc-on-bedrock/litellm:latest
USERDATA
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "cc-litellm" }
  }
}

resource "aws_autoscaling_group" "this" {
  name                      = "cc-litellm-asg"
  min_size                  = 2
  max_size                  = 4
  desired_capacity          = 2
  vpc_zone_identifier       = var.private_subnet_ids
  health_check_type         = "ELB"
  health_check_grace_period = 120
  target_group_arns         = [aws_lb_target_group.this.arn]

  launch_template {
    id      = aws_launch_template.this.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "cc-litellm"
    propagate_at_launch = true
  }
}
