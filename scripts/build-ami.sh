#!/bin/bash
set -euo pipefail

# CC-on-Bedrock AMI Builder
# Launches a temporary EC2 instance, runs setup scripts, creates AMI, terminates instance.
# Must run from an environment with AWS credentials and VPC access.
#
# Usage: ./build-ami.sh [instance-type] [volume-size-gb]
# Example: ./build-ami.sh t4g.medium 30

INSTANCE_TYPE="${1:-t4g.medium}"
VOLUME_SIZE="${2:-30}"
REGION="${AWS_REGION:-ap-northeast-2}"
AMI_NAME="cc-on-bedrock-devenv-$(date +%Y%m%d-%H%M%S)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== CC-on-Bedrock AMI Builder ==="
echo "Instance type: $INSTANCE_TYPE"
echo "Volume size: ${VOLUME_SIZE}GB"
echo "Region: $REGION"

# Find latest Ubuntu 24.04 ARM64 AMI
echo "Finding base AMI..."
BASE_AMI=$(aws ec2 describe-images \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" \
    "Name=architecture,Values=arm64" \
    "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text \
  --region "$REGION")
echo "Base AMI: $BASE_AMI"

# Find a private subnet
SUBNET_ID=$(aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=*cc-on-bedrock*Private*" \
  --query 'Subnets[0].SubnetId' \
  --output text \
  --region "$REGION" 2>/dev/null)
if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" = "None" ]; then
  SUBNET_ID=$(aws ec2 describe-subnets \
    --filters "Name=tag:aws-cdk:subnet-type,Values=Private" \
    --query 'Subnets[0].SubnetId' \
    --output text \
    --region "$REGION")
fi
echo "Subnet: $SUBNET_ID"

# Find IAM instance profile (reuse existing devenv role)
INSTANCE_PROFILE="cc-on-bedrock-devenv-builder"
aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE" &>/dev/null || {
  echo "Creating temporary instance profile..."
  ROLE_NAME="cc-on-bedrock-dashboard-ec2"
  aws iam create-instance-profile --instance-profile-name "$INSTANCE_PROFILE"
  aws iam add-role-to-instance-profile --instance-profile-name "$INSTANCE_PROFILE" --role-name "$ROLE_NAME"
  sleep 10  # Wait for propagation
}

# Find security group (SSM only, no SSH)
SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=*DevenvSgOpen*" \
  --query 'SecurityGroups[0].GroupId' \
  --output text \
  --region "$REGION" 2>/dev/null)
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  SG_ID=$(aws ec2 describe-security-groups \
    --filters "Name=tag:Name,Values=*cc-on-bedrock*" \
    --query 'SecurityGroups[0].GroupId' \
    --output text \
    --region "$REGION")
fi
echo "Security Group: $SG_ID"

# Launch temporary instance
echo "Launching build instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$BASE_AMI" \
  --instance-type "$INSTANCE_TYPE" \
  --subnet-id "$SUBNET_ID" \
  --security-group-ids "$SG_ID" \
  --iam-instance-profile Name="$INSTANCE_PROFILE" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$VOLUME_SIZE,\"VolumeType\":\"gp3\",\"Encrypted\":true}}]" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cc-ami-builder},{Key=managed_by,Value=cc-on-bedrock}]" \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2" \
  --query 'Instances[0].InstanceId' \
  --output text \
  --region "$REGION")
echo "Instance: $INSTANCE_ID"

echo "Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

echo "Waiting for SSM agent..."
for i in $(seq 1 30); do
  STATUS=$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' \
    --output text \
    --region "$REGION" 2>/dev/null || echo "None")
  if [ "$STATUS" = "Online" ]; then break; fi
  echo "  Waiting... ($i/30)"
  sleep 10
done

if [ "$STATUS" != "Online" ]; then
  echo "ERROR: SSM agent not online after 5 minutes"
  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
  exit 1
fi

echo "=== Running setup scripts via SSM ==="

# Upload and run setup scripts
run_script() {
  local script_path="$1"
  local script_name=$(basename "$script_path")
  echo "Running $script_name..."

  # Read script content, wrap in bash + prepend environment for SSM (which uses /bin/sh)
  local script_content
  script_content="#!/bin/bash
export HOME=/root
export DEBIAN_FRONTEND=noninteractive
$(cat "$script_path")"

  COMMAND_ID=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --parameters "{\"commands\":[$(echo "$script_content" | jq -Rs .)]}" \
    --timeout-seconds 600 \
    --query 'Command.CommandId' \
    --output text \
    --region "$REGION")

  # Wait for completion
  aws ssm wait command-executed \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --region "$REGION" 2>/dev/null || true

  STATUS=$(aws ssm get-command-invocation \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --query 'Status' \
    --output text \
    --region "$REGION")

  if [ "$STATUS" != "Success" ]; then
    echo "ERROR: $script_name failed (status: $STATUS)"
    aws ssm get-command-invocation \
      --command-id "$COMMAND_ID" \
      --instance-id "$INSTANCE_ID" \
      --query 'StandardErrorContent' \
      --output text \
      --region "$REGION"
    aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
    exit 1
  fi
  echo "  $script_name completed"
}

run_script "$PROJECT_ROOT/docker/devenv/scripts/setup-common.sh"
run_script "$PROJECT_ROOT/docker/devenv/scripts/setup-claude-code.sh"
run_script "$PROJECT_ROOT/docker/devenv/scripts/setup-kiro.sh"

# Install SSM agent + CloudWatch agent + code-server systemd service
echo "Running EC2-specific setup..."
COMMAND_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=[
    "# SSM agent is pre-installed on Ubuntu AMI",
    "# Install CloudWatch Agent",
    "wget -q https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb -O /tmp/cw-agent.deb",
    "dpkg -i /tmp/cw-agent.deb && rm /tmp/cw-agent.deb",
    "# Remove PEP 668 restriction",
    "rm -f /usr/lib/python3*/EXTERNALLY-MANAGED",
    "# code-server systemd service",
    "cat > /etc/systemd/system/code-server.service << EOF",
    "[Unit]",
    "Description=code-server",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    "User=coder",
    "Environment=CLAUDE_CODE_USE_BEDROCK=1",
    "ExecStart=/usr/bin/code-server --bind-addr 0.0.0.0:8080 --auth password",
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "EOF",
    "systemctl daemon-reload",
    "systemctl enable code-server",
    "# Cleanup",
    "apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*",
    "echo AMI setup complete"
  ]' \
  --timeout-seconds 300 \
  --query 'Command.CommandId' \
  --output text \
  --region "$REGION")

aws ssm wait command-executed --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" --region "$REGION" 2>/dev/null || true

# Stop instance before creating AMI (clean state)
echo "Stopping instance for AMI creation..."
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID" --region "$REGION"

# Create AMI
echo "Creating AMI: $AMI_NAME..."
AMI_ID=$(aws ec2 create-image \
  --instance-id "$INSTANCE_ID" \
  --name "$AMI_NAME" \
  --description "CC-on-Bedrock DevEnv: Ubuntu 24.04 ARM64 + code-server + Claude Code + Kiro" \
  --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=$AMI_NAME},{Key=managed_by,Value=cc-on-bedrock}]" \
  --query 'ImageId' \
  --output text \
  --region "$REGION")
echo "AMI ID: $AMI_ID"

echo "Waiting for AMI to be available..."
aws ec2 wait image-available --image-ids "$AMI_ID" --region "$REGION"

# Store AMI ID in SSM Parameter Store
aws ssm put-parameter \
  --name "/cc-on-bedrock/devenv/ami-id" \
  --value "$AMI_ID" \
  --type String \
  --overwrite \
  --region "$REGION"
echo "AMI ID stored in SSM: /cc-on-bedrock/devenv/ami-id"

# Terminate build instance
echo "Terminating build instance..."
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"

echo "=== AMI Build Complete ==="
echo "AMI ID: $AMI_ID"
echo "AMI Name: $AMI_NAME"
echo "SSM Parameter: /cc-on-bedrock/devenv/ami-id"
