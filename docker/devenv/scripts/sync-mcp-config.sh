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
DEFAULT_REGION="ap-northeast-2"

# Ensure .claude directory exists
mkdir -p "$CLAUDE_DIR"

write_fallback_config() {
  local region="${REGION:-$DEFAULT_REGION}"
  cat > "$MCP_CONFIG" << MCPEOF
{
  "awslabs-core-mcp-server": {
    "command": "uvx",
    "args": ["awslabs.core-mcp-server@latest"],
    "env": {
      "AWS_REGION": "${region}"
    }
  },
  "bedrock-agentcore-mcp-server": {
    "command": "uvx",
    "args": ["bedrock-agentcore-mcp-server@latest"],
    "env": {
      "AWS_REGION": "${region}"
    }
  }
}
MCPEOF
  chown coder:coder "$MCP_CONFIG" 2>/dev/null || true
  chmod 644 "$MCP_CONFIG" 2>/dev/null || true
  log "Fallback MCP config written (region=${region})"
}

# Get instance metadata
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
META_HEADER=""
if [ -n "$TOKEN" ]; then
  META_HEADER="-H X-aws-ec2-metadata-token:${TOKEN}"
fi

INSTANCE_ID=$(curl -s $META_HEADER http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "")
REGION=$(curl -s $META_HEADER http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "$DEFAULT_REGION")

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

# Query DynamoDB for department Gateway URL (jq for safe JSON key construction)
DEPT_KEY=$(jq -n --arg dept "$DEPT" '{"PK":{"S":("DEPT#"+$dept)},"SK":{"S":"GATEWAY"}}')
DEPT_GW=$(aws dynamodb get-item \
  --table-name cc-dept-mcp-config \
  --key "$DEPT_KEY" \
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

# ─── Plugin Marketplace Sync ───
# Query common + department marketplaces from DynamoDB and register via Claude CLI
CLAUDE_BIN=$(command -v claude 2>/dev/null || echo "")
if [ -n "$CLAUDE_BIN" ]; then
  COMMON_MKT=$(aws dynamodb query \
    --table-name cc-dept-mcp-config \
    --key-condition-expression "PK = :pk AND begins_with(SK, :sk)" \
    --expression-attribute-values '{":pk":{"S":"COMMON"},":sk":{"S":"MKTPLACE#"}}' \
    --projection-expression "#u,enabled" \
    --expression-attribute-names '{"#u":"url"}' \
    --region "$REGION" --output json 2>/dev/null || echo '{"Items":[]}')

  DEPT_MKT=$(aws dynamodb query \
    --table-name cc-dept-mcp-config \
    --key-condition-expression "PK = :pk AND begins_with(SK, :sk)" \
    --expression-attribute-values "$(jq -n --arg dept "$DEPT" '{":pk":{"S":("DEPT#"+$dept)},":sk":{"S":"MKTPLACE#"}}')" \
    --projection-expression "#u,enabled" \
    --expression-attribute-names '{"#u":"url"}' \
    --region "$REGION" --output json 2>/dev/null || echo '{"Items":[]}')

  MKT_URLS=$(echo "$COMMON_MKT" "$DEPT_MKT" | jq -r '.Items[] | select(.enabled.BOOL==true) | .url.S' 2>/dev/null || true)

  GITHUB_URL_RE='^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/?$'
  while IFS= read -r URL; do
    [ -z "$URL" ] && continue
    if ! [[ "$URL" =~ $GITHUB_URL_RE ]]; then
      log "WARN: Skipping invalid marketplace URL: $URL"
      continue
    fi
    # Pipe slash command via stdin (claude CLI accepts REPL input on stdin in non-TTY mode)
    OUTPUT=$(printf '/plugin marketplace add %s\n' "$URL" \
      | sudo -u coder "$CLAUDE_BIN" --print 2>&1) && \
      log "Added marketplace: $URL" || \
      log "WARN: Failed to add marketplace: $URL ($(echo "$OUTPUT" | head -1))"
  done <<< "$MKT_URLS"

  [ -z "$MKT_URLS" ] && log "No plugin marketplaces configured"
else
  log "WARN: claude CLI not found, skipping plugin marketplace sync"
fi

exit 0
