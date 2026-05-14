#!/bin/bash
set -euo pipefail

# CC-on-Bedrock AMI Builder
# Launches a temporary EC2 instance, runs setup scripts, creates AMI, terminates instance.
#
# Usage: ./build-ami.sh <os-type> [instance-type] [volume-size-gb]
# Example: ./build-ami.sh ubuntu t4g.medium 30
#          ./build-ami.sh al2023

OS_TYPE="${1:-ubuntu}"
INSTANCE_TYPE="${2:-t4g.medium}"
VOLUME_SIZE="${3:-30}"
REGION="${AWS_REGION:-ap-northeast-2}"
AMI_NAME="cc-on-bedrock-devenv-${OS_TYPE}-$(date +%Y%m%d-%H%M%S)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$OS_TYPE" != "ubuntu" ] && [ "$OS_TYPE" != "al2023" ]; then
  echo "ERROR: OS type must be 'ubuntu' or 'al2023'"
  exit 1
fi

echo "=== CC-on-Bedrock AMI Builder ==="
echo "OS type: $OS_TYPE"
echo "Instance type: $INSTANCE_TYPE"
echo "Volume size: ${VOLUME_SIZE}GB"
echo "Region: $REGION"

# Find base AMI based on OS type
echo "Finding base AMI..."
if [ "$OS_TYPE" = "ubuntu" ]; then
  BASE_AMI=$(aws ec2 describe-images \
    --owners 099720109477 \
    --filters \
      "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" \
      "Name=architecture,Values=arm64" \
      "Name=state,Values=available" \
    --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
    --output text \
    --region "$REGION")
else
  BASE_AMI=$(aws ec2 describe-images \
    --owners amazon \
    --filters \
      "Name=name,Values=al2023-ami-2023.*-kernel-*-arm64" \
      "Name=architecture,Values=arm64" \
      "Name=state,Values=available" \
    --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
    --output text \
    --region "$REGION")
fi
echo "Base AMI: $BASE_AMI ($OS_TYPE)"

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
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cc-ami-builder-${OS_TYPE}},{Key=managed_by,Value=cc-on-bedrock}]" \
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

# OS-specific EC2 setup (SSM agent, CWAgent, code-server, hibernation)
echo "Running EC2-specific setup ($OS_TYPE)..."

if [ "$OS_TYPE" = "ubuntu" ]; then
  # Ubuntu: snap SSM → deb SSM, apt-based installs
  COMMAND_ID=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --parameters 'commands=[
      "# Replace snap SSM agent with deb version (ADR-010: snap SSM fails to reconnect after hibernate)",
      "snap stop amazon-ssm-agent 2>/dev/null || true",
      "snap remove amazon-ssm-agent 2>/dev/null || true",
      "wget -q https://s3.ap-northeast-2.amazonaws.com/amazon-ssm-ap-northeast-2/latest/debian_arm64/amazon-ssm-agent.deb -O /tmp/ssm.deb",
      "dpkg -i /tmp/ssm.deb && rm /tmp/ssm.deb",
      "systemctl enable amazon-ssm-agent",
      "# Install CloudWatch Agent",
      "wget -q https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb -O /tmp/cw-agent.deb",
      "dpkg -i /tmp/cw-agent.deb && rm /tmp/cw-agent.deb",
      "# Remove PEP 668 restriction",
      "rm -f /usr/lib/python3*/EXTERNALLY-MANAGED",
      "# EC2 Hibernation agent (ADR-010)",
      "apt-get update -qq && apt-get install -y ec2-hibinit-agent",
      "echo GRUB_CMDLINE_LINUX_DEFAULT=\\\"nokaslr\\\" > /etc/default/grub.d/99-hibernation.cfg",
      "update-grub",
      "# Cleanup",
      "apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*"
    ]' \
    --timeout-seconds 300 \
    --query 'Command.CommandId' \
    --output text \
    --region "$REGION")
else
  # AL2023: dnf-based installs, SSM already included
  COMMAND_ID=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --parameters 'commands=[
      "# SSM agent is pre-installed on AL2023",
      "systemctl enable amazon-ssm-agent",
      "# Install CloudWatch Agent",
      "dnf install -y amazon-cloudwatch-agent",
      "# EC2 Hibernation agent",
      "dnf install -y ec2-hibinit-agent",
      "# Cleanup",
      "dnf clean all && rm -rf /tmp/*"
    ]' \
    --timeout-seconds 300 \
    --query 'Command.CommandId' \
    --output text \
    --region "$REGION")
fi

aws ssm wait command-executed --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" --region "$REGION" 2>/dev/null || true

# Common EC2 setup: CWAgent config, code-server service, hibernate resume, MCP sync
echo "Running common EC2 setup..."
COMMON_SETUP_SCRIPT=$(cat << 'SETUPEOF'
#!/bin/bash
set -euo pipefail

# Configure CloudWatch Agent for memory and disk metrics
mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWCFG'
{
  "metrics": {
    "namespace": "CWAgent",
    "append_dimensions": { "InstanceId": "${aws:InstanceId}" },
    "aggregation_dimensions": [["InstanceId"]],
    "metrics_collected": {
      "mem": {
        "measurement": ["mem_used_percent", "mem_used", "mem_total"],
        "metrics_collection_interval": 60
      },
      "disk": {
        "measurement": ["disk_used_percent", "disk_used", "disk_total"],
        "resources": ["/"],
        "metrics_collection_interval": 60
      },
      "diskio": {
        "measurement": ["read_bytes", "write_bytes"],
        "resources": ["*"],
        "metrics_collection_interval": 60
      }
    }
  }
}
CWCFG
systemctl enable amazon-cloudwatch-agent

# code-server systemd service
cat > /etc/systemd/system/code-server.service << 'CSSVC'
[Unit]
Description=code-server
After=network.target

[Service]
Type=simple
User=coder
Environment=CLAUDE_CODE_USE_BEDROCK=1
ExecStart=/usr/bin/code-server --bind-addr 0.0.0.0:8080 --auth password
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
CSSVC
systemctl daemon-reload

# Pre-create code-server config
sudo -u coder mkdir -p /home/coder/.config/code-server /home/coder/workspace
cat > /home/coder/.config/code-server/config.yaml << 'CSCFG'
bind-addr: 0.0.0.0:8080
auth: password
password: changeme
cert: false
CSCFG
chown -R coder:coder /home/coder/.config /home/coder/workspace
systemctl enable code-server

# ADR-010: Restart agents after hibernate resume
cat > /etc/systemd/system/hibernate-resume-agents.service << 'HRSVC'
[Unit]
Description=Restart SSM, CloudWatch, code-server agents after hibernate resume
After=hibernate.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c "systemctl restart amazon-ssm-agent; systemctl restart amazon-cloudwatch-agent 2>/dev/null; systemctl restart code-server 2>/dev/null; logger -t hibernate-resume agents-restarted"

[Install]
WantedBy=hibernate.target
HRSVC
systemctl daemon-reload
systemctl enable hibernate-resume-agents.service

echo "Common EC2 setup complete"
SETUPEOF
)

COMMAND_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "{\"commands\":[$(echo "$COMMON_SETUP_SCRIPT" | jq -Rs .)]}" \
  --timeout-seconds 300 \
  --query 'Command.CommandId' \
  --output text \
  --region "$REGION")

aws ssm wait command-executed --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" --region "$REGION" 2>/dev/null || true

# Install MCP/Plugin sync scripts and systemd services
echo "Installing MCP sync scripts..."
MCP_INSTALL_SCRIPT=$(mktemp /tmp/mcp-install-XXXXX.sh)
cat > "$MCP_INSTALL_SCRIPT" << 'MCPINSTALLEOF'
#!/bin/bash
set -euo pipefail
mkdir -p /opt/cc-on-bedrock
MCPINSTALLEOF

# Append sync-mcp-config.sh as a heredoc write
{
  echo 'cat > /opt/cc-on-bedrock/sync-mcp-config.sh << '"'"'SYNCEOF'"'"''
  cat "$PROJECT_ROOT/docker/devenv/scripts/sync-mcp-config.sh"
  echo 'SYNCEOF'
  echo 'chmod +x /opt/cc-on-bedrock/sync-mcp-config.sh'
  echo ''
  echo 'cat > /etc/systemd/system/cc-mcp-sync.service << '"'"'SVCEOF'"'"''
  cat "$PROJECT_ROOT/docker/devenv/systemd/cc-mcp-sync.service"
  echo 'SVCEOF'
  echo ''
  echo 'systemctl daemon-reload'
  echo 'systemctl enable cc-mcp-sync.service'
  echo 'echo "MCP sync scripts installed"'
} >> "$MCP_INSTALL_SCRIPT"

run_script "$MCP_INSTALL_SCRIPT"
rm -f "$MCP_INSTALL_SCRIPT"

# Stop instance before creating AMI (clean state)
echo "Stopping instance for AMI creation..."
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID" --region "$REGION"

# Create AMI
echo "Creating AMI: $AMI_NAME..."
AMI_ID=$(aws ec2 create-image \
  --instance-id "$INSTANCE_ID" \
  --name "$AMI_NAME" \
  --description "CC-on-Bedrock DevEnv: ${OS_TYPE} ARM64 + code-server + Claude Code + Kiro" \
  --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=$AMI_NAME},{Key=managed_by,Value=cc-on-bedrock},{Key=os_type,Value=$OS_TYPE}]" \
  --query 'ImageId' \
  --output text \
  --region "$REGION")
echo "AMI ID: $AMI_ID"

echo "Waiting for AMI to be available..."
aws ec2 wait image-available --image-ids "$AMI_ID" --region "$REGION"

# Store AMI ID in SSM Parameter Store (per-OS + legacy fallback)
aws ssm put-parameter \
  --name "/cc-on-bedrock/devenv/ami-id/${OS_TYPE}" \
  --value "$AMI_ID" \
  --type String \
  --overwrite \
  --region "$REGION"
echo "AMI ID stored in SSM: /cc-on-bedrock/devenv/ami-id/${OS_TYPE}"

# Also update legacy parameter if ubuntu (backwards compatibility)
if [ "$OS_TYPE" = "ubuntu" ]; then
  aws ssm put-parameter \
    --name "/cc-on-bedrock/devenv/ami-id" \
    --value "$AMI_ID" \
    --type String \
    --overwrite \
    --region "$REGION"
  echo "Legacy parameter updated: /cc-on-bedrock/devenv/ami-id"
fi

# Terminate build instance
echo "Terminating build instance..."
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"

echo "=== AMI Build Complete ==="
echo "OS type: $OS_TYPE"
echo "AMI ID: $AMI_ID"
echo "AMI Name: $AMI_NAME"
echo "SSM Parameter: /cc-on-bedrock/devenv/ami-id/${OS_TYPE}"
