#!/bin/bash
# CC-on-Bedrock MCP Config Sync
# Runs on EC2 boot (systemd service) to generate ~/.claude/mcp_servers.json
# Queries DynamoDB for department Gateway URL and merges with local MCP servers.
#
# Dependencies: aws-cli, curl, jq (pre-installed in AMI)

set -euo pipefail

LOG_TAG="cc-mcp-sync"
log() { logger -t "$LOG_TAG" "$@"; echo "[$LOG_TAG] $*"; }

# Determine the coder user home
CODER_HOME="/home/coder"
CLAUDE_DIR="${CODER_HOME}/.claude"
MCP_CONFIG="${CLAUDE_DIR}/mcp_servers.json"

# Ensure .claude directory exists
mkdir -p "$CLAUDE_DIR"

# Get instance metadata
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
META_HEADER=""
if [ -n "$TOKEN" ]; then
  META_HEADER="-H X-aws-ec2-metadata-token:${TOKEN}"
fi

INSTANCE_ID=$(curl -s $META_HEADER http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "")
REGION=$(curl -s $META_HEADER http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "ap-northeast-2")

if [ -z "$INSTANCE_ID" ]; then
  log "ERROR: Could not get instance ID from metadata. Using fallback config."
  write_fallback_config
  exit 0
fi

# Get department from instance tags
DEPT=$(aws ec2 describe-tags \
  --filters "Name=resource-id,Values=${INSTANCE_ID}" "Name=key,Values=department" \
  --query 'Tags[0].Value' --output text --region "$REGION" 2>/dev/null || echo "None")

if [ "$DEPT" = "None" ] || [ -z "$DEPT" ]; then
  log "WARN: No department tag found for ${INSTANCE_ID}. Using fallback config."
  write_fallback_config
  exit 0
fi

log "Department: ${DEPT}, Region: ${REGION}"

# Query DynamoDB for department Gateway URL
DEPT_GW=$(aws dynamodb get-item \
  --table-name cc-dept-mcp-config \
  --key '{"PK":{"S":"DEPT#'"${DEPT}"'"},"SK":{"S":"GATEWAY"}}' \
  --query 'Item.gatewayUrl.S' --output text --region "$REGION" 2>/dev/null || echo "None")

# Query common Gateway URL
COMMON_GW=$(aws dynamodb get-item \
  --table-name cc-dept-mcp-config \
  --key '{"PK":{"S":"COMMON"},"SK":{"S":"GATEWAY"}}' \
  --query 'Item.gatewayUrl.S' --output text --region "$REGION" 2>/dev/null || echo "None")

log "Common GW: ${COMMON_GW:-None}, Dept GW: ${DEPT_GW:-None}"

# Build mcp_servers.json
# Start with local MCP servers (always present)
cat > "$MCP_CONFIG" << MCPEOF
{
  "awslabs-core-mcp-server": {
    "command": "uvx",
    "args": ["awslabs.core-mcp-server@latest"],
    "env": {
      "AWS_REGION": "${REGION}"
    }
  },
  "bedrock-agentcore-mcp-server": {
    "command": "uvx",
    "args": ["bedrock-agentcore-mcp-server@latest"],
    "env": {
      "AWS_REGION": "${REGION}"
    }
  }
MCPEOF

# Append common gateway if available
if [ "$COMMON_GW" != "None" ] && [ -n "$COMMON_GW" ]; then
  cat >> "$MCP_CONFIG" << MCPEOF
  ,"cc-common-gateway": {
    "url": "${COMMON_GW}",
    "env": {
      "AWS_REGION": "${REGION}"
    }
  }
MCPEOF
  log "Added common gateway: ${COMMON_GW}"
fi

# Append department gateway if available
if [ "$DEPT_GW" != "None" ] && [ -n "$DEPT_GW" ]; then
  cat >> "$MCP_CONFIG" << MCPEOF
  ,"cc-dept-${DEPT}-gateway": {
    "url": "${DEPT_GW}",
    "env": {
      "AWS_REGION": "${REGION}"
    }
  }
MCPEOF
  log "Added department gateway (${DEPT}): ${DEPT_GW}"
fi

# Close JSON
echo "}" >> "$MCP_CONFIG"

# Fix ownership
chown coder:coder "$MCP_CONFIG"
chmod 644 "$MCP_CONFIG"

log "MCP config written to ${MCP_CONFIG}"
exit 0

# Fallback function — local MCPs only
write_fallback_config() {
  cat > "$MCP_CONFIG" << 'MCPEOF'
{
  "awslabs-core-mcp-server": {
    "command": "uvx",
    "args": ["awslabs.core-mcp-server@latest"],
    "env": {
      "AWS_REGION": "ap-northeast-2"
    }
  },
  "bedrock-agentcore-mcp-server": {
    "command": "uvx",
    "args": ["bedrock-agentcore-mcp-server@latest"],
    "env": {
      "AWS_REGION": "ap-northeast-2"
    }
  }
}
MCPEOF
  chown coder:coder "$MCP_CONFIG" 2>/dev/null || true
  chmod 644 "$MCP_CONFIG" 2>/dev/null || true
  log "Fallback MCP config written"
}
