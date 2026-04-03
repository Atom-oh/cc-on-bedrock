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

# --- Per-user directory isolation ---
# EBS mode: /data is EBS volume, symlink /home/coder + /usr/local into it
# EFS AP mode: /home/coder IS the user's root via Access Point
# EFS fallback: /home/coder/users/{subdomain}/ for isolation
STORAGE_TYPE="${STORAGE_TYPE:-efs}"
if [ "$STORAGE_TYPE" = "ebs" ]; then
  echo "Setting up EBS volume at /data..."

  # Migrate: if old snapshot has files at /data root (from /home/coder mount era), move to /data/home
  if [ -f /data/.bashrc ] && [ ! -d /data/home/.bashrc.d ]; then
    echo "Migrating old /home/coder data from /data root to /data/home..."
    mkdir -p /data/home
    for item in /data/.* /data/*; do
      base=$(basename "$item")
      [ "$base" = "." ] || [ "$base" = ".." ] || [ "$base" = "home" ] || [ "$base" = "usr-local" ] || [ "$base" = "lost+found" ] && continue
      mv "$item" /data/home/ 2>/dev/null || true
    done
  fi

  mkdir -p /data/home /data/usr-local
  chown -R coder:coder /data/home /data/usr-local

  # Persist /usr/local: copy from Docker image backup on first boot or image update
  # /usr/local.bak is created at build time and always contains the correct binaries
  IMAGE_ID=$(cat /opt/devenv/.image-id 2>/dev/null || echo "unknown")
  STORED_ID=$(cat /data/usr-local/.image-id 2>/dev/null || echo "none")
  if [ "$IMAGE_ID" != "$STORED_ID" ] && [ -d /usr/local.bak ]; then
    echo "Initializing /usr/local from image (image=$IMAGE_ID, stored=$STORED_ID)..."
    cp -a /usr/local.bak/* /data/usr-local/ 2>/dev/null || true
    echo "$IMAGE_ID" > /data/usr-local/.image-id
  fi
  rm -rf /usr/local && ln -sf /data/usr-local /usr/local
  echo "Symlinked /usr/local → /data/usr-local"

  # Persist /home/coder
  rm -rf "$USER_HOME" && ln -sf /data/home "$USER_HOME"
  echo "Symlinked /home/coder → /data/home"

  # Refresh PATH to pick up symlinked binaries
  export PATH="/data/usr-local/bin:$PATH"

  EFS_USER_DIR="$USER_HOME"
  echo "Using EBS volume: /data (home + usr-local)"
elif [ -n "${EFS_ACCESS_POINT:-}" ] || [ "${STORAGE_ISOLATED:-}" = "true" ]; then
  EFS_USER_DIR="$USER_HOME"
  echo "Using isolated EFS (Access Point): $EFS_USER_DIR"
else
  EFS_USER_DIR="$USER_HOME/users/$SUBDOMAIN"
  echo "Using shared EFS with subdirectory: $EFS_USER_DIR"
fi
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

# Ensure correct ownership (ignore errors: AP enforces uid/gid, symlinks may be root-owned)
chown -R coder:coder "$EFS_USER_DIR" 2>/dev/null || true

# --- Configure Kiro for Bedrock ---
cat > "$EFS_USER_DIR/.kiro/settings/bedrock.json" << KIROEOF
{
  "aws_region": "${AWS_DEFAULT_REGION:-ap-northeast-2}",
  "bearer_token": "${AWS_BEARER_TOKEN_BEDROCK:-}"
}
KIROEOF
chown coder:coder "$EFS_USER_DIR/.kiro/settings/bedrock.json" 2>/dev/null || true

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
chown coder:coder "$EFS_USER_DIR/.claude/mcp_servers.json" 2>/dev/null || true

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
  chown coder:coder "$USER_DATA_DIR/User/settings.json" 2>/dev/null || true
fi

# --- Ensure .bashrc.d sourcing in user's bashrc ---
USER_BASHRC="$EFS_USER_DIR/.bashrc"
if [ ! -f "$USER_BASHRC" ]; then
  cp /etc/skel/.bashrc "$USER_BASHRC" 2>/dev/null || touch "$USER_BASHRC"
  chown coder:coder "$USER_BASHRC" 2>/dev/null || true
fi
if ! grep -q 'bashrc.d' "$USER_BASHRC" 2>/dev/null; then
  echo 'for f in ~/.bashrc.d/*.sh; do [ -r "$f" ] && source "$f"; done' >> "$USER_BASHRC"
fi

# --- Symlink user config to home directory ---
# code-server and Claude Code expect configs in $HOME
# Skip when STORAGE_ISOLATED (Access Point: EFS_USER_DIR == USER_HOME, no symlink needed)
if [ "$EFS_USER_DIR" != "$USER_HOME" ]; then
  for item in .bashrc .bashrc.d .claude .kiro .config; do
    src="$EFS_USER_DIR/$item"
    dst="$USER_HOME/$item"
    if [ -e "$src" ] && [ ! -L "$dst" ]; then
      rm -rf "$dst" 2>/dev/null || true
      ln -sf "$src" "$dst"
    fi
  done
fi

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
  # Setup periodic sync — use cron if available, else background loop
  if command -v crontab &>/dev/null; then
    echo "*/5 * * * * /opt/devenv/scripts/s3-sync.sh sync >> /var/log/s3-sync.log 2>&1" | crontab -u coder -
    crond 2>/dev/null || cron 2>/dev/null || true
    echo "S3 sync configured: restore complete, cron scheduled"
  else
    # Fallback: background sync loop every 5 minutes
    (while true; do sleep 300; /opt/devenv/scripts/s3-sync.sh sync >> /var/log/s3-sync.log 2>&1; done) &
    echo "S3 sync configured: restore complete, background loop scheduled (no cron)"
  fi
fi

# --- Verify Task Role credentials ---
if [ -n "$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" ]; then
  echo "Using ECS Task Role credentials (endpoint: $AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)"
else
  echo "WARNING: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI not set, may fall back to IMDS"
fi

# --- Start code-server ---
# Claude Code: Bedrock mode via per-user Task Role (cc-on-bedrock-task-{subdomain})
# CLAUDE_CODE_USE_BEDROCK=1 required to force Bedrock mode in ECS
# Capture ECS credential endpoint vars before sudo strips them
ECS_CREDS_URI="${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}"
ECS_CREDS_FULL_URI="${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}"
ECS_CREDS_TOKEN="${AWS_CONTAINER_AUTHORIZATION_TOKEN:-}"

cat > /etc/profile.d/claude-env.sh << ENVEOF
export CLAUDE_CODE_USE_BEDROCK=1
export ANTHROPIC_MODEL='global.anthropic.claude-opus-4-6-v1[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL='global.anthropic.claude-opus-4-6-v1[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='global.anthropic.claude-sonnet-4-6[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='global.anthropic.claude-haiku-4-5-20251001-v1:0'
export ANTHROPIC_SMALL_FAST_MODEL='us.anthropic.claude-haiku-4-5-20251001-v1:0'
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=32768
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export AWS_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export HOME="$USER_HOME"
# ECS Task Role credentials (propagated from root PID 1 through sudo -u coder)
export AWS_CONTAINER_CREDENTIALS_RELATIVE_URI="${ECS_CREDS_URI}"
export AWS_CONTAINER_CREDENTIALS_FULL_URI="${ECS_CREDS_FULL_URI}"
export AWS_CONTAINER_AUTHORIZATION_TOKEN="${ECS_CREDS_TOKEN}"
ENVEOF
chmod 644 /etc/profile.d/claude-env.sh
if ! grep -q "profile.d/claude-env" "$USER_BASHRC" 2>/dev/null; then
  echo '[ -f /etc/profile.d/claude-env.sh ] && source /etc/profile.d/claude-env.sh' >> "$USER_BASHRC"
fi
# Resolve code-server password (priority: env var > Secrets Manager > random)
if [ -n "${CODESERVER_PASSWORD:-}" ]; then
  RESOLVED_PASSWORD="$CODESERVER_PASSWORD"
  echo "Using code-server password from environment variable"
elif [ -n "${CODESERVER_SECRET_ARN:-}" ]; then
  RESOLVED_PASSWORD=$(aws secretsmanager get-secret-value \
    --secret-id "$CODESERVER_SECRET_ARN" \
    --region "${AWS_DEFAULT_REGION:-ap-northeast-2}" \
    --query SecretString --output text 2>/dev/null) || RESOLVED_PASSWORD=""
  if [ -n "$RESOLVED_PASSWORD" ]; then
    echo "Using code-server password from Secrets Manager"
  else
    RESOLVED_PASSWORD=$(openssl rand -hex 16)
    echo "WARNING: Secrets Manager read failed, using generated random password"
  fi
else
  RESOLVED_PASSWORD=$(openssl rand -hex 16)
  echo "WARNING: No password configured, using generated random password"
fi

# Force write config.yaml with resolved password (overrides stale EFS config)
mkdir -p /home/coder/.config/code-server
cat > /home/coder/.config/code-server/config.yaml << CFGEOF
bind-addr: 0.0.0.0:8080
auth: ${CODESERVER_AUTH:-password}
password: "${RESOLVED_PASSWORD}"
cert: false
CFGEOF
chown coder:coder /home/coder/.config/code-server/config.yaml 2>/dev/null || true

echo "Starting code-server for user: $SUBDOMAIN (Bedrock native mode)"
exec sudo -u coder \
  code-server \
  --bind-addr 0.0.0.0:8080 \
  --auth "${CODESERVER_AUTH:-password}" \
  --user-data-dir "$USER_DATA_DIR" \
  $CODESERVER_FLAGS \
  "$USER_WORKSPACE"
