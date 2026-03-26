###############################################################################
# ECS DevEnv Module - Cluster, Task Definitions, EFS, ALB, CloudFront, DLP SGs
# Equivalent to cdk/lib/04-ecs-devenv-stack.ts
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ---- IAM: ECS Task Role (created here to match CDK pattern) -----------------
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task" {
  name               = "cc-on-bedrock-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "ecs_task_bedrock" {
  name = "bedrock-invoke"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = "*"
    }]
  })
}

# ---- IAM: ECS Task Execution Role -------------------------------------------
resource "aws_iam_role" "ecs_task_execution" {
  name               = "cc-on-bedrock-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_exec_policy" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "ecs_exec_ecr" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy" "ecs_exec_secrets" {
  name = "secrets-access"
  role = aws_iam_role.ecs_task_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:cc-on-bedrock/*"
    }]
  })
}

# ---- ECR Repository ----------------------------------------------------------
resource "aws_ecr_repository" "devenv" {
  name                 = "cc-on-bedrock/devenv"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

# ---- EFS File System ---------------------------------------------------------
resource "aws_efs_file_system" "this" {
  encrypted  = true
  kms_key_id = var.kms_key_arn

  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"

  lifecycle_policy {
    transition_to_ia = "AFTER_14_DAYS"
  }

  tags = { Name = "cc-on-bedrock-devenv" }
}

resource "aws_efs_mount_target" "isolated_a" {
  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = var.isolated_subnet_ids[0]
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_mount_target" "isolated_c" {
  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = var.isolated_subnet_ids[1]
  security_groups = [aws_security_group.efs.id]
}

# ---- S3 Bucket for User Workspace Data --------------------------------------
resource "aws_s3_bucket" "user_data" {
  bucket = "cc-on-bedrock-user-data-${data.aws_caller_identity.current.account_id}"
  tags   = { Name = "cc-on-bedrock-user-data" }
}

resource "aws_s3_bucket_versioning" "user_data" {
  bucket = aws_s3_bucket.user_data.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "user_data" {
  bucket = aws_s3_bucket.user_data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "user_data" {
  bucket = aws_s3_bucket.user_data.id
  rule {
    id     = "noncurrent-cleanup"
    status = "Enabled"
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

# ---- DynamoDB Table for User Volumes ----------------------------------------
resource "aws_dynamodb_table" "user_volumes" {
  name         = "cc-user-volumes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"

  attribute {
    name = "user_id"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  point_in_time_recovery { enabled = true }
  tags = { Name = "cc-user-volumes" }
}

# ---- DLP Security Groups ----------------------------------------------------
resource "aws_security_group" "dlp_open" {
  name_prefix = "cc-devenv-open-"
  description = "DLP: Open - all outbound"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-devenv-sg-open" }
}

resource "aws_security_group" "dlp_restricted" {
  name_prefix = "cc-devenv-restricted-"
  description = "DLP: Restricted - whitelist outbound"
  vpc_id      = var.vpc_id

  egress {
    description = "Allow VPC internal"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Allow HTTPS for whitelisted domains"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-devenv-sg-restricted" }
}

resource "aws_security_group" "dlp_locked" {
  name_prefix = "cc-devenv-locked-"
  description = "DLP: Locked - VPC only"
  vpc_id      = var.vpc_id

  egress {
    description = "Allow VPC internal only"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "cc-devenv-sg-locked" }
}

# ---- EFS Security Group (allow from all DLP SGs) ----------------------------
resource "aws_security_group" "efs" {
  name_prefix = "cc-devenv-efs-"
  description = "Allow NFS from devenv DLP SGs"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow EFS from devenv (open)"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.dlp_open.id]
  }

  ingress {
    description     = "Allow EFS from devenv (restricted)"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.dlp_restricted.id]
  }

  ingress {
    description     = "Allow EFS from devenv (locked)"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.dlp_locked.id]
  }

  tags = { Name = "cc-devenv-efs-sg" }
}

# ---- ECS Cluster -------------------------------------------------------------
resource "aws_ecs_cluster" "this" {
  name = "cc-on-bedrock-devenv"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ---- ECS Capacity Provider (m7g.4xlarge ASG) ---------------------------------
data "aws_ssm_parameter" "ecs_arm64_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id"
}

resource "aws_launch_template" "ecs_capacity" {
  name_prefix   = "cc-devenv-ecs-"
  image_id      = data.aws_ssm_parameter.ecs_arm64_ami.value
  instance_type = var.ecs_host_instance_type

  user_data = base64encode(<<-USERDATA
#!/bin/bash
echo "ECS_CLUSTER=${aws_ecs_cluster.this.name}" >> /etc/ecs/ecs.config
USERDATA
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "cc-devenv-ecs-host" }
  }
}

resource "aws_autoscaling_group" "ecs_capacity" {
  name                = "cc-devenv-ecs-capacity"
  min_size            = 0
  max_size            = 15
  desired_capacity    = 0
  vpc_zone_identifier = var.private_subnet_ids

  protect_from_scale_in = false

  launch_template {
    id      = aws_launch_template.ecs_capacity.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "cc-devenv-ecs-host"
    propagate_at_launch = true
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
}

resource "aws_ecs_capacity_provider" "this" {
  name = "cc-devenv-capacity-provider"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs_capacity.arn
    managed_termination_protection = "DISABLED"

    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 80
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 10
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = [aws_ecs_capacity_provider.this.name]
}

# ---- CloudWatch Log Group ----------------------------------------------------
resource "aws_cloudwatch_log_group" "devenv" {
  name              = "/cc-on-bedrock/ecs/devenv"
  retention_in_days = 30
}

# ---- ECS Task Definitions (6 variants: 2 OS x 3 tiers) ----------------------
locals {
  tiers = {
    light    = { cpu = 1024, memory = 4096 }
    standard = { cpu = 2048, memory = 8192 }
    power    = { cpu = 4096, memory = 12288 }
  }
  os_variants = ["ubuntu", "al2023"]
  task_combos = flatten([
    for os in local.os_variants : [
      for tier_name, tier in local.tiers : {
        key    = "${os}-${tier_name}"
        os     = os
        tier   = tier_name
        cpu    = tier.cpu
        memory = tier.memory
      }
    ]
  ])
}

resource "aws_ecs_task_definition" "devenv" {
  for_each = { for tc in local.task_combos : tc.key => tc }

  family       = "devenv-${each.key}"
  network_mode = "awsvpc"

  task_role_arn      = aws_iam_role.ecs_task.arn
  execution_role_arn = aws_iam_role.ecs_task_execution.arn

  container_definitions = jsonencode([{
    name      = "devenv"
    image     = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/cc-on-bedrock/devenv:${each.value.os}-latest"
    cpu       = each.value.cpu
    memory    = each.value.memory
    essential = true

    portMappings = [{ containerPort = 8080 }]

    environment = [
      { name = "ANTHROPIC_BASE_URL", value = "http://${var.litellm_alb_dns}:4000" },
      { name = "AWS_DEFAULT_REGION", value = data.aws_region.current.name },
      { name = "SECURITY_POLICY", value = "open" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.devenv.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "${each.value.os}-${each.value.tier}"
      }
    }

    mountPoints = [{
      sourceVolume  = "efs-workspace"
      containerPath = "/home/coder"
      readOnly      = false
    }]
  }])

  volume {
    name = "efs-workspace"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.this.id
      transit_encryption = "ENABLED"
    }
  }

  tags = { Name = "devenv-${each.key}" }
}

# ---- ALB for Dev Environment -------------------------------------------------
resource "aws_security_group" "alb" {
  name_prefix = "cc-devenv-alb-"
  description = "DevEnv ALB SG"
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

  tags = { Name = "cc-devenv-alb-sg" }
}

resource "aws_lb" "this" {
  name               = "cc-devenv-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  tags = { Name = "cc-devenv-alb" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.devenv_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

# ---- CloudFront Distribution -------------------------------------------------
resource "aws_cloudfront_distribution" "this" {
  comment = "CC-on-Bedrock Dev Environment"
  enabled = true

  origin {
    domain_name = aws_lb.this.dns_name
    origin_id   = "devenv-alb"

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
    target_origin_id       = "devenv-alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    # Disable caching (equivalent to CachePolicy.CACHING_DISABLED)
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    # ALL_VIEWER origin request policy
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "cc-devenv-cloudfront" }
}

# ---- Route 53 Wildcard Record ------------------------------------------------
resource "aws_route53_record" "wildcard" {
  zone_id = var.hosted_zone_id
  name    = "*.${var.dev_subdomain}.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
