###############################################################################
# EC2-per-user DevEnv Module (ADR-004)
# Per-user EC2 DevEnv infrastructure
#
# Each user gets a dedicated EC2 instance with persistent EBS root volume.
# Dashboard API creates per-user IAM roles + Instance Profiles at runtime, then
# RunInstances against this Launch Template. Stop/Start preserves all state.
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  bedrock_resources = [
    "arn:aws:bedrock:*::foundation-model/*anthropic.claude-*",
    "arn:aws:bedrock:*:${local.account_id}:inference-profile/*anthropic.claude-*",
    "arn:aws:bedrock:*::foundation-model/*embed*",
    "arn:aws:bedrock:*:${local.account_id}:inference-profile/*embed*",
    "arn:aws:bedrock:*:${local.account_id}:application-inference-profile/*",
  ]

  # Allowed DevEnv ports
  devenv_ports = [
    { port = 8080, desc = "code-server" },
    { port = 3000, desc = "frontend dev server" },
    { port = 8000, desc = "API server" },
  ]
}

# ─── DLP Security Groups (no SSH, SSM only) ──────────────────────────────────
resource "aws_security_group" "open" {
  name_prefix = "cc-devenv-open-"
  description = "DevEnv Open: code-server + frontend + API + all outbound"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.nginx_security_group_id == "" ? local.devenv_ports : []
    content {
      description = "${ingress.value.desc} from VPC (via Nginx)"
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = "tcp"
      cidr_blocks = [var.vpc_cidr]
    }
  }

  dynamic "ingress" {
    for_each = var.nginx_security_group_id != "" ? [1] : []
    content {
      description     = "Nginx to code-server and user custom ports"
      from_port       = 1024
      to_port         = 65535
      protocol        = "tcp"
      security_groups = [var.nginx_security_group_id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "cc-devenv-sg-open" }
}

resource "aws_security_group" "restricted" {
  name_prefix = "cc-devenv-restricted-"
  description = "DevEnv Restricted: code-server + frontend + API, limited outbound"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.nginx_security_group_id == "" ? local.devenv_ports : []
    content {
      description = "${ingress.value.desc} from VPC"
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = "tcp"
      cidr_blocks = [var.vpc_cidr]
    }
  }

  dynamic "ingress" {
    for_each = var.nginx_security_group_id != "" ? [1] : []
    content {
      description     = "Nginx to code-server and user custom ports"
      from_port       = 1024
      to_port         = 65535
      protocol        = "tcp"
      security_groups = [var.nginx_security_group_id]
    }
  }

  egress {
    description = "HTTPS outbound"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  # OTLP/gRPC to the in-VPC OTEL collector (ADR-009 native telemetry). Without this the
  # restricted tier's egress (DNS + 443 only) blocks the collector, so no metrics/events flow.
  egress {
    description = "OTLP/HTTP to in-VPC OTEL collector"
    from_port   = 4318
    to_port     = 4318
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  # DNS ONLY via the VPC resolver — external DNS (e.g. 8.8.8.8) would bypass
  # the Route 53 DNS Firewall threat blocks and enable DNS-tunnel exfiltration.
  egress {
    description = "DNS to VPC resolver (+2) only"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["${cidrhost(var.vpc_cidr, 2)}/32"]
  }
  egress {
    description = "DNS UDP to VPC resolver (+2) only"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["${cidrhost(var.vpc_cidr, 2)}/32"]
  }

  tags = { Name = "cc-devenv-sg-restricted" }
}

resource "aws_security_group" "locked" {
  name_prefix = "cc-devenv-locked-"
  description = "DevEnv Locked: code-server + frontend + API, no outbound except AWS VPC endpoints"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.nginx_security_group_id == "" ? local.devenv_ports : []
    content {
      description = "${ingress.value.desc} from VPC"
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = "tcp"
      cidr_blocks = [var.vpc_cidr]
    }
  }

  dynamic "ingress" {
    for_each = var.nginx_security_group_id != "" ? [1] : []
    content {
      description     = "Nginx to code-server and user custom ports"
      from_port       = 1024
      to_port         = 65535
      protocol        = "tcp"
      security_groups = [var.nginx_security_group_id]
    }
  }

  egress {
    description = "HTTPS to VPC endpoints only"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  # OTLP/gRPC to the in-VPC OTEL collector (ADR-009 native telemetry). Internal-only
  # (VPC CIDR); the collector SG still gates who may connect.
  egress {
    description = "OTLP/HTTP to in-VPC OTEL collector"
    from_port   = 4318
    to_port     = 4318
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  # DNS to the in-VPC Route 53 Resolver (VPC base + 2) ONLY — required for name
  # resolution AND for DNS Firewall rules to see locked-tier queries. Scoped to
  # the single resolver IP so a rogue in-VPC DNS server can't bypass the firewall.
  egress {
    description = "DNS to VPC resolver (+2) only"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["${cidrhost(var.vpc_cidr, 2)}/32"]
  }

  egress {
    description = "DNS UDP to VPC resolver (+2) only"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["${cidrhost(var.vpc_cidr, 2)}/32"]
  }

  tags = { Name = "cc-devenv-sg-locked" }
}

# ─── IAM Role for the per-user EC2 instance ──────────────────────────────────
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "devenv_instance" {
  name               = "cc-on-bedrock-devenv-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  # Empty string -> attribute omitted entirely.
  permissions_boundary = var.task_permission_boundary_arn != "" ? var.task_permission_boundary_arn : null
}

resource "aws_iam_role_policy_attachment" "devenv_ssm" {
  role       = aws_iam_role.devenv_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "devenv_cw_agent" {
  role       = aws_iam_role.devenv_instance.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

data "aws_iam_policy_document" "devenv_bedrock" {
  statement {
    sid       = "BedrockAccess"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
    resources = local.bedrock_resources
  }
  statement {
    sid       = "KmsDecrypt"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "devenv_bedrock" {
  role   = aws_iam_role.devenv_instance.id
  name   = "bedrock-and-kms"
  policy = data.aws_iam_policy_document.devenv_bedrock.json
}

resource "aws_iam_instance_profile" "devenv" {
  name = "cc-on-bedrock-devenv-instance"
  role = aws_iam_role.devenv_instance.name
}

# ─── Launch Template (AMI ID injected by build-ami.sh -> SSM) ────────────────
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_launch_template" "devenv" {
  name          = "cc-on-bedrock-devenv"
  image_id      = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = var.devenv_instance_type

  # No iam_instance_profile here — per-user instance profile attached at RunInstances time
  vpc_security_group_ids = [aws_security_group.open.id]

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }

  hibernation_options {
    configured = true # ADR-010
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true  # Required for Hibernation
      delete_on_termination = false # Preserve data on Stop/Hibernate
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name       = "cc-devenv"
      managed_by = "cc-on-bedrock"
    }
  }
}

# ─── DynamoDB: user_id -> instance mapping ────────────────────────────────────
resource "aws_dynamodb_table" "user_instances" {
  name         = "cc-user-instances"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"

  attribute {
    name = "user_id"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  lifecycle {
    prevent_destroy = false
  }
  tags = { Name = "cc-user-instances" }
}
