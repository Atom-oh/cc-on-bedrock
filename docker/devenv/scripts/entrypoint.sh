#!/bin/bash
set -euo pipefail

# --- Graceful shutdown: sync to S3 before exit ---
cleanup() {
  echo "Container stopping - running final S3 sync..."
  if [ -n "${S3_SYNC_BUCKET:-}" ]; then
    /opt/devenv/scripts/s3-sync.sh full-backup || true
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT

echo "=== CC-on-Bedrock Devenv Container Starting ==="

USER_HOME="/home/coder"
SECURITY_POLICY="${SECURITY_POLICY:-open}"
SUBDOMAIN="${USER_SUBDOMAIN:-default}"

# --- Per-user EFS directory isolation ---
# EFS is mounted at /home/coder (shared root).
# Each user gets their own subdirectory: /home/coder/users/{subdomain}/
# code-server workspace points to the user's directory.
EFS_USER_DIR="$USER_HOME/users/$SUBDOMAIN"
USER_WORKSPACE="$EFS_USER_DIR/workspace"
USER_DATA_DIR="$EFS_USER_DIR/.local/share/code-server"
USER_CONFIG_DIR="$EFS_USER_DIR/.config"

echo "Setting up user directory: $EFS_USER_DIR"

# Create per-user directory structure on EFS
mkdir -p "$USER_WORKSPACE"
mkdir -p "$USER_DATA_DIR/User"
mkdir -p "$USER_CONFIG_DIR"
mkdir -p "$EFS_USER_DIR/.bashrc.d"
mkdir -p "$EFS_USER_DIR/.claude"
mkdir -p "$EFS_USER_DIR/.kiro/settings"

# Ensure correct ownership (only user's directory, not entire EFS)
chown -R coder:coder "$EFS_USER_DIR"

# --- Configure Kiro for Bedrock ---
cat > "$EFS_USER_DIR/.kiro/settings/bedrock.json" << KIROEOF
{
  "aws_region": "${AWS_DEFAULT_REGION:-ap-northeast-2}",
  "bearer_token": "${AWS_BEARER_TOKEN_BEDROCK:-}"
}
KIROEOF
chown coder:coder "$EFS_USER_DIR/.kiro/settings/bedrock.json"

# --- MCP Server Configuration ---
cat > "$EFS_USER_DIR/.claude/mcp_servers.json" << MCPEOF
{
  "awslabs-core-mcp-server": {
    "command": "uvx",
    "args": ["awslabs.core-mcp-server@latest"],
    "env": {"AWS_REGION": "${AWS_DEFAULT_REGION:-ap-northeast-2}"}
  },
  "bedrock-agentcore-mcp-server": {
    "command": "uvx",
    "args": ["bedrock-agentcore-mcp-server@latest"],
    "env": {"AWS_REGION": "${AWS_DEFAULT_REGION:-ap-northeast-2}"}
  }
}
MCPEOF
chown coder:coder "$EFS_USER_DIR/.claude/mcp_servers.json"

# --- Security Policy: code-server flags ---
CODESERVER_FLAGS=""
case "$SECURITY_POLICY" in
  restricted)
    echo "Applying RESTRICTED security policy"
    CODESERVER_FLAGS="--disable-file-downloads --disable-file-uploads"
    if [ -d /opt/extensions-approved ]; then
      CODESERVER_FLAGS="$CODESERVER_FLAGS --extensions-dir /opt/extensions-approved"
    fi
    ;;
  locked)
    echo "Applying LOCKED security policy"
    CODESERVER_FLAGS="--disable-file-downloads --disable-file-uploads"
    if [ -d /opt/extensions-readonly ]; then
      CODESERVER_FLAGS="$CODESERVER_FLAGS --extensions-dir /opt/extensions-readonly"
    fi
    ;;
  *)
    echo "Applying OPEN security policy"
    ;;
esac

# --- Copy default VSCode settings if not exists ---
if [ ! -f "$USER_DATA_DIR/User/settings.json" ]; then
  cp /opt/devenv/config/settings.json "$USER_DATA_DIR/User/settings.json"
  chown coder:coder "$USER_DATA_DIR/User/settings.json"
fi

# --- Ensure .bashrc.d sourcing in user's bashrc ---
USER_BASHRC="$EFS_USER_DIR/.bashrc"
if [ ! -f "$USER_BASHRC" ]; then
  cp /etc/skel/.bashrc "$USER_BASHRC" 2>/dev/null || touch "$USER_BASHRC"
  chown coder:coder "$USER_BASHRC"
fi
if ! grep -q 'bashrc.d' "$USER_BASHRC" 2>/dev/null; then
  echo 'for f in ~/.bashrc.d/*.sh; do [ -r "$f" ] && source "$f"; done' >> "$USER_BASHRC"
fi

# --- Symlink user config to home directory ---
# code-server and Claude Code expect configs in $HOME
for item in .bashrc .bashrc.d .claude .kiro .config; do
  src="$EFS_USER_DIR/$item"
  dst="$USER_HOME/$item"
  if [ -e "$src" ] && [ ! -L "$dst" ]; then
    rm -rf "$dst" 2>/dev/null || true
    ln -sf "$src" "$dst"
  fi
done

# --- Start idle monitor in background ---
/opt/devenv/scripts/idle-monitor.sh &

# --- Enterprise: Proxy Configuration ---
if [ -n "${HTTP_PROXY:-}" ]; then
  echo "Configuring proxy: $HTTP_PROXY"
  cat > /etc/profile.d/proxy-env.sh << PROXYEOF
export HTTP_PROXY="${HTTP_PROXY}"
export HTTPS_PROXY="${HTTPS_PROXY:-$HTTP_PROXY}"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,169.254.169.254,.amazonaws.com}"
export http_proxy="${HTTP_PROXY}"
export https_proxy="${HTTPS_PROXY:-$HTTP_PROXY}"
export no_proxy="${NO_PROXY:-localhost,127.0.0.1,169.254.169.254,.amazonaws.com}"
PROXYEOF
  chmod 644 /etc/profile.d/proxy-env.sh
  # Apply to current shell for S3 sync
  source /etc/profile.d/proxy-env.sh
  # Configure npm proxy
  sudo -u coder npm config set proxy "$HTTP_PROXY" 2>/dev/null || true
  sudo -u coder npm config set https-proxy "${HTTPS_PROXY:-$HTTP_PROXY}" 2>/dev/null || true
fi

# --- S3 Data Restore (if S3_SYNC_BUCKET is set) ---
if [ -n "${S3_SYNC_BUCKET:-}" ]; then
  echo "Restoring workspace from S3..."
  /opt/devenv/scripts/s3-sync.sh restore || echo "S3 restore failed, continuing with empty workspace"
  # Setup periodic sync cron (every 5 minutes)
  echo "*/5 * * * * /opt/devenv/scripts/s3-sync.sh sync >> /var/log/s3-sync.log 2>&1" | crontab -u coder -
  crond || cron || echo "Cron daemon not available"  # Start cron daemon (works on both AL2023 and Ubuntu)
  echo "S3 sync configured: restore complete, cron scheduled"
fi

# --- Start code-server ---
# Claude Code: Bedrock mode via Task Role
# CLAUDE_CODE_USE_BEDROCK=1 required to force Bedrock mode in ECS
cat > /etc/profile.d/claude-env.sh << ENVEOF
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export AWS_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export HOME="$USER_HOME"
ENVEOF
chmod 644 /etc/profile.d/claude-env.sh
if ! grep -q "profile.d/claude-env" "$USER_BASHRC" 2>/dev/null; then
  echo '[ -f /etc/profile.d/claude-env.sh ] && source /etc/profile.d/claude-env.sh' >> "$USER_BASHRC"
fi
echo "Starting code-server for user: $SUBDOMAIN (Bedrock native mode)"
exec sudo -u coder \
  PASSWORD="${CODESERVER_PASSWORD:-}" \
  code-server \
  --bind-addr 0.0.0.0:8080 \
  --auth "${CODESERVER_AUTH:-password}" \
  --user-data-dir "$USER_DATA_DIR" \
  $CODESERVER_FLAGS \
  "$USER_WORKSPACE"
