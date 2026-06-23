###############################################################################
# Shared Nginx Router Module
#
# Canonical EC2 path:
#   CloudFront -> NLB -> nginx on ECS Fargate -> per-user EC2 DevEnv
#
# This module owns only the shared routing plane. Per-user compute, EBS GP3,
# instance profiles, and DLP security groups live in modules/ec2-devenv.
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# ---- ECR Repository: shared Nginx router image ------------------------------
resource "aws_ecr_repository" "nginx" {
  name                 = "cc-on-bedrock/nginx"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [encryption_configuration]
  }
}

# ---- S3 Bucket for generated nginx.conf -------------------------------------
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
    id     = "nginx-config-history"
    status = "Enabled"
    filter { prefix = "" }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

# ---- Routing table: subdomain -> EC2 private IP + custom routes -------------
resource "aws_dynamodb_table" "routing" {
  name             = "cc-routing-table"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "subdomain"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "subdomain"
    type = "S"
  }

  point_in_time_recovery { enabled = true }

  tags = { Name = "cc-routing-table" }
}

# ---- Nginx config generator Lambda ------------------------------------------
data "archive_file" "nginx_config_gen" {
  type        = "zip"
  source_file = "${var.lambda_src_dir}/nginx-config-gen.py"
  output_path = "${path.module}/.build/nginx-config-gen.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "nginx_config_gen" {
  name               = "cc-on-bedrock-nginx-config-gen-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "nginx_config_gen_basic" {
  role       = aws_iam_role.nginx_config_gen.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "nginx_config_gen" {
  statement {
    sid       = "RoutingTableRead"
    actions   = ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
    resources = [aws_dynamodb_table.routing.arn, aws_dynamodb_table.routing.stream_arn]
  }

  statement {
    sid       = "InstanceRouteStatusWrite"
    actions   = ["dynamodb:UpdateItem"]
    resources = ["arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/cc-user-instances"]
  }

  statement {
    sid     = "ConfigBucketWrite"
    actions = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.user_data.arn,
      "${aws_s3_bucket.user_data.arn}/*",
    ]
  }

  statement {
    sid       = "KmsForConfigBucket"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "nginx_config_gen" {
  role   = aws_iam_role.nginx_config_gen.id
  name   = "nginx-config-gen"
  policy = data.aws_iam_policy_document.nginx_config_gen.json
}

resource "aws_cloudwatch_log_group" "nginx_config_gen" {
  name              = "/aws/lambda/cc-on-bedrock-nginx-config-gen"
  retention_in_days = 30
}

resource "aws_lambda_function" "nginx_config_gen" {
  function_name    = "cc-on-bedrock-nginx-config-gen"
  role             = aws_iam_role.nginx_config_gen.arn
  runtime          = "python3.12"
  handler          = "nginx-config-gen.handler"
  filename         = data.archive_file.nginx_config_gen.output_path
  source_code_hash = data.archive_file.nginx_config_gen.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      ROUTING_TABLE     = aws_dynamodb_table.routing.name
      CONFIG_BUCKET     = aws_s3_bucket.user_data.id
      CONFIG_KEY        = "nginx/nginx.conf"
      DEV_DOMAIN        = "${var.dev_subdomain}.${var.domain_name}"
      REGION            = data.aws_region.current.name
      CLOUDFRONT_SECRET = var.cloudfront_secret_value
      VPC_CIDR          = var.vpc_cidr
      INSTANCE_TABLE    = "cc-user-instances"
    }
  }

  depends_on = [aws_cloudwatch_log_group.nginx_config_gen]
}

resource "aws_lambda_event_source_mapping" "routing_to_nginx_config" {
  event_source_arn  = aws_dynamodb_table.routing.stream_arn
  function_name     = aws_lambda_function.nginx_config_gen.arn
  starting_position = "TRIM_HORIZON"
  batch_size        = 10

  maximum_retry_attempts = 3
}

# ---- ECS cluster and Nginx Fargate service ----------------------------------
resource "aws_ecs_cluster" "this" {
  name = "cc-on-bedrock-devenv"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "nginx_task" {
  name               = "cc-on-bedrock-nginx-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role" "nginx_task_execution" {
  name               = "cc-on-bedrock-nginx-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "nginx_exec_policy" {
  role       = aws_iam_role.nginx_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "nginx_exec_ecr" {
  role       = aws_iam_role.nginx_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

data "aws_iam_policy_document" "nginx_task" {
  statement {
    sid     = "ConfigBucketRead"
    actions = ["s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.user_data.arn,
      "${aws_s3_bucket.user_data.arn}/*",
    ]
  }
  statement {
    sid       = "KmsDecrypt"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "nginx_task" {
  role   = aws_iam_role.nginx_task.id
  name   = "nginx-config-read"
  policy = data.aws_iam_policy_document.nginx_task.json
}

resource "aws_cloudwatch_log_group" "nginx" {
  name              = "/cc-on-bedrock/ecs/nginx"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "nginx" {
  family                   = "cc-nginx-proxy"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  task_role_arn            = aws_iam_role.nginx_task.arn
  execution_role_arn       = aws_iam_role.nginx_task_execution.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "nginx"
    image     = "${aws_ecr_repository.nginx.repository_url}:latest"
    essential = true

    portMappings = [{ containerPort = 80, protocol = "tcp" }]

    environment = [
      { name = "CONFIG_BUCKET", value = aws_s3_bucket.user_data.id },
      { name = "CONFIG_KEY", value = "nginx/nginx.conf" },
      { name = "RELOAD_INTERVAL", value = "5" },
      { name = "AWS_DEFAULT_REGION", value = data.aws_region.current.name },
      { name = "AWS_REGION", value = data.aws_region.current.name },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.nginx.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "nginx"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:80/health || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])
}

resource "aws_security_group" "nginx" {
  name_prefix = "cc-nginx-"
  description = "Shared Nginx reverse proxy"
  vpc_id      = var.vpc_id

  ingress {
    description = "NLB to Nginx"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-nginx-sg" }
}

resource "aws_security_group" "nlb" {
  name_prefix = "cc-devenv-nlb-"
  description = "NLB SG for CloudFront origin traffic"
  vpc_id      = var.vpc_id

  ingress {
    description     = "CloudFront origin-facing HTTP"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-devenv-nlb-sg" }
}

resource "aws_lb" "nlb" {
  name               = "cc-devenv-nlb"
  internal           = false
  load_balancer_type = "network"
  security_groups    = [aws_security_group.nlb.id]
  subnets            = var.public_subnet_ids

  enable_cross_zone_load_balancing = true

  tags = { Name = "cc-devenv-nlb" }
}

resource "aws_lb_target_group" "nginx" {
  name        = "cc-nginx-targets"
  port        = 80
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    protocol            = "HTTP"
    path                = "/health"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
  }
}

resource "aws_lb_listener" "nlb" {
  load_balancer_arn = aws_lb.nlb.arn
  port              = 80
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.nginx.arn
  }
}

resource "aws_ecs_service" "nginx" {
  name            = "cc-nginx-proxy"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.nginx.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  enable_execute_command             = true
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.nginx.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.nginx.arn
    container_name   = "nginx"
    container_port   = 80
  }

  depends_on = [aws_lb_listener.nlb]
}

# ---- OTEL Collector for EC2 code activity metrics ---------------------------
resource "aws_security_group" "otel_collector" {
  name_prefix = "cc-otel-collector-"
  description = "Internal OTEL Collector endpoint"
  vpc_id      = var.vpc_id

  ingress {
    description = "OTLP HTTP from DevEnv EC2 instances"
    from_port   = 4318
    to_port     = 4318
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-otel-collector-sg" }
}

resource "aws_cloudwatch_log_group" "otel_collector" {
  name              = "/cc-on-bedrock/otel/collector"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "otel_code_metrics" {
  name              = "/cc-on-bedrock/otel/code-metrics"
  retention_in_days = 90
}

resource "aws_iam_role" "otel_task" {
  name               = "cc-on-bedrock-otel-collector-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "otel_task" {
  statement {
    sid       = "CloudWatchEmf"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "cloudwatch:PutMetricData"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "otel_task" {
  role   = aws_iam_role.otel_task.id
  name   = "otel-cloudwatch-export"
  policy = data.aws_iam_policy_document.otel_task.json
}

locals {
  otel_collector_config = <<-YAML
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch: {}
exporters:
  awsemf:
    namespace: CCOnBedrock/CodeMetrics
    log_group_name: /cc-on-bedrock/otel/code-metrics
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [awsemf]
YAML
}

resource "aws_ecs_task_definition" "otel_collector" {
  family                   = "cc-otel-collector"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  task_role_arn            = aws_iam_role.otel_task.arn
  execution_role_arn       = aws_iam_role.nginx_task_execution.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "otel-collector"
    image     = "public.ecr.aws/aws-observability/aws-otel-collector:latest"
    essential = true
    command   = ["--config=env:OTEL_CONFIG"]

    portMappings = [{ containerPort = 4318, protocol = "tcp" }]

    environment = [
      { name = "OTEL_CONFIG", value = local.otel_collector_config },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.otel_collector.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "collector"
      }
    }
  }])
}

resource "aws_lb" "otel_collector" {
  name               = "cc-otel-collector-nlb"
  internal           = true
  load_balancer_type = "network"
  security_groups    = [aws_security_group.otel_collector.id]
  subnets            = var.private_subnet_ids

  enable_cross_zone_load_balancing = true

  tags = { Name = "cc-otel-collector-nlb" }
}

resource "aws_lb_target_group" "otel_collector" {
  name        = "cc-otel-collector"
  port        = 4318
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    protocol            = "TCP"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }
}

resource "aws_lb_listener" "otel_collector" {
  load_balancer_arn = aws_lb.otel_collector.arn
  port              = 4318
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.otel_collector.arn
  }
}

resource "aws_ecs_service" "otel_collector" {
  name            = "cc-otel-collector"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.otel_collector.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.otel_collector.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.otel_collector.arn
    container_name   = "otel-collector"
    container_port   = 4318
  }

  depends_on = [aws_lb_listener.otel_collector]
}

# ---- DevEnv Lambda@Edge Session Validator -----------------------------------
data "archive_file" "devenv_session_validator" {
  type        = "zip"
  output_path = "${path.module}/.build/devenv-session-validator.zip"

  source {
    filename = "index.js"
    content = replace(
      replace(
        replace(
          file("${var.lambda_src_dir}/devenv-session-validator/index.js"),
          "__DEV_DOMAIN__",
          "${var.dev_subdomain}.${var.domain_name}"
        ),
        "__DASHBOARD_URL__",
        "https://cconbedrock-dashboard.${var.domain_name}"
      ),
      "__SSM_REGION__",
      data.aws_region.current.name
    )
  }
}

data "aws_iam_policy_document" "edge_lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "devenv_session_validator" {
  provider           = aws.us_east_1
  name               = "cc-on-bedrock-devenv-session-validator-edge"
  assume_role_policy = data.aws_iam_policy_document.edge_lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "devenv_session_validator_basic" {
  provider   = aws.us_east_1
  role       = aws_iam_role.devenv_session_validator.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "devenv_session_validator_ssm" {
  statement {
    sid       = "ReadNextAuthSecret"
    actions   = ["ssm:GetParameter"]
    resources = [var.nextauth_secret_ssm_parameter_arn]
  }
}

resource "aws_iam_role_policy" "devenv_session_validator_ssm" {
  provider = aws.us_east_1
  role     = aws_iam_role.devenv_session_validator.id
  name     = "read-nextauth-secret"
  policy   = data.aws_iam_policy_document.devenv_session_validator_ssm.json
}

resource "aws_lambda_function" "devenv_session_validator" {
  provider         = aws.us_east_1
  function_name    = "cc-on-bedrock-devenv-session-validator"
  role             = aws_iam_role.devenv_session_validator.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.devenv_session_validator.output_path
  source_code_hash = data.archive_file.devenv_session_validator.output_base64sha256
  publish          = true
  timeout          = 5
  memory_size      = 128
  description      = "NextAuth session validator for *.${var.dev_subdomain}.${var.domain_name}"
}

# ---- CloudFront + Route 53 wildcard -----------------------------------------
resource "aws_cloudfront_distribution" "this" {
  comment = "CC-on-Bedrock DevEnv (*.dev domain)"
  enabled = true

  web_acl_id = var.web_acl_arn != "" ? var.web_acl_arn : null

  origin {
    domain_name = aws_lb.nlb.dns_name
    origin_id   = "devenv-nlb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-Custom-Secret"
      value = var.cloudfront_secret_value
    }
  }

  default_cache_behavior {
    target_origin_id       = "devenv-nlb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"

    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.devenv_session_validator.qualified_arn
      include_body = false
    }
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
