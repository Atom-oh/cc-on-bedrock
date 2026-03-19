# Plan 1: Docker Images Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build production-ready Docker images for devenv (Ubuntu + AL2023) and LiteLLM proxy, pushable to ECR.

**Architecture:** Three Docker images share common setup logic. The devenv images provide code-server + Claude Code + Kiro in two OS flavors. The LiteLLM image wraps the official image with custom config and Secrets Manager integration.

**Tech Stack:** Docker, bash, code-server, Claude Code CLI, Kiro CLI, Node.js 20, Python 3, AWS CLI v2, LiteLLM

**Spec:** `docs/superpowers/specs/2026-03-19-cc-on-bedrock-design.md`

---

## File Structure

```
cc-on-bedrock/
├── docker/
│   ├── devenv/
│   │   ├── Dockerfile.ubuntu          # Ubuntu 24.04 ARM64 devenv image
│   │   ├── Dockerfile.al2023          # Amazon Linux 2023 ARM64 devenv image
│   │   ├── scripts/
│   │   │   ├── setup-common.sh        # Shared install logic (Node.js, code-server, Claude Code, Kiro, tools)
│   │   │   ├── setup-claude-code.sh   # Claude Code CLI + plugins + MCP servers
│   │   │   ├── setup-kiro.sh          # Kiro CLI setup
│   │   │   ├── entrypoint.sh          # Container startup (security policy, code-server launch)
│   │   │   └── idle-monitor.sh        # Idle detection for auto-timeout
│   │   └── config/
│   │       ├── settings.json          # VSCode default settings
│   │       └── extensions.txt         # Pre-approved extension list
│   ├── litellm/
│   │   ├── Dockerfile                 # LiteLLM proxy image
│   │   ├── litellm-config.yaml        # Model routing + Valkey config (template)
│   │   └── scripts/
│   │       └── entrypoint.sh          # Secrets Manager fetch + LiteLLM startup
│   └── build.sh                       # Build + push all images to ECR
├── tests/
│   └── docker/
│       ├── test-devenv.sh             # Devenv container integration tests
│       ├── test-litellm.sh            # LiteLLM container integration tests
│       └── test-scripts.sh            # Shell script linting (shellcheck)
└── scripts/
    └── create-ecr-repos.sh            # Create ECR repositories
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `docker/devenv/scripts/` (directory)
- Create: `docker/devenv/config/` (directory)
- Create: `docker/litellm/scripts/` (directory)
- Create: `scripts/` (directory)

- [ ] **Step 1: Create directory structure**

```bash
cd /home/ec2-user/my-project/cc-on-bedrock
mkdir -p docker/devenv/scripts
mkdir -p docker/devenv/config
mkdir -p docker/litellm/scripts
mkdir -p scripts
```

- [ ] **Step 2: Create ECR repository setup script**

Create: `scripts/create-ecr-repos.sh`

```bash
#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
REPOS=("cc-on-bedrock/devenv" "cc-on-bedrock/litellm")

for REPO in "${REPOS[@]}"; do
  echo "Creating ECR repository: $REPO"
  aws ecr create-repository \
    --repository-name "$REPO" \
    --region "$REGION" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=KMS \
    2>/dev/null || echo "  Repository $REPO already exists"
done

echo "ECR repositories ready."
```

- [ ] **Step 3: Commit scaffolding**

```bash
git init
git add -A
git commit -m "chore: initial project scaffolding with docker and scripts directories"
```

---

### Task 2: Devenv Common Setup Script

**Files:**
- Create: `docker/devenv/scripts/setup-common.sh`

This is the core install script shared by both Ubuntu and AL2023 images. It detects the OS and uses the appropriate package manager.

- [ ] **Step 1: Write setup-common.sh**

Create: `docker/devenv/scripts/setup-common.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== CC-on-Bedrock Devenv: Common Setup ==="

# Detect OS
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="$ID"
else
  echo "ERROR: Cannot detect OS"
  exit 1
fi

echo "Detected OS: $OS_ID"

# --- Package Manager Setup ---
install_packages() {
  case "$OS_ID" in
    ubuntu)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y --no-install-recommends \
        curl wget git jq unzip tar gzip ca-certificates \
        build-essential python3 python3-pip python3-venv \
        openssh-client sudo locales
      # Set locale
      locale-gen en_US.UTF-8
      ;;
    amzn)
      dnf update -y -q
      dnf install -y -q \
        curl wget git jq unzip tar gzip ca-certificates \
        gcc gcc-c++ make python3 python3-pip \
        openssh-clients sudo
      ;;
    *)
      echo "ERROR: Unsupported OS: $OS_ID"
      exit 1
      ;;
  esac
}

# --- Create coder user ---
create_user() {
  if ! id coder &>/dev/null; then
    useradd -m -s /bin/bash -d /home/coder coder
    echo "coder ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/coder
    chmod 0440 /etc/sudoers.d/coder
  fi
}

# --- Node.js 20 via fnm ---
install_nodejs() {
  echo "Installing Node.js 20 via fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir /usr/local/bin --skip-shell
  export PATH="/usr/local/bin:$PATH"
  eval "$(fnm env)"
  fnm install 20
  fnm default 20

  # Make node/npm globally available
  NODE_PATH=$(fnm exec --using=20 which node)
  NODE_DIR=$(dirname "$NODE_PATH")
  ln -sf "$NODE_DIR/node" /usr/local/bin/node
  ln -sf "$NODE_DIR/npm" /usr/local/bin/npm
  ln -sf "$NODE_DIR/npx" /usr/local/bin/npx

  echo "Node.js $(node --version) installed"
}

# --- Python uv ---
install_uv() {
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | env CARGO_HOME=/usr/local sh
  # Ensure uv is on PATH for all users
  ln -sf /root/.local/bin/uv /usr/local/bin/uv 2>/dev/null || true
  echo "uv installed"
}

# --- AWS CLI v2 (ARM64) ---
install_awscli() {
  echo "Installing AWS CLI v2..."
  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ]; then
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
  else
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  fi
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/aws /tmp/awscliv2.zip
  echo "AWS CLI $(aws --version) installed"
}

# --- code-server ---
install_codeserver() {
  echo "Installing code-server..."
  curl -fsSL https://code-server.dev/install.sh | sh
  echo "code-server $(code-server --version | head -1) installed"
}

# --- Docker CLI ---
install_docker_cli() {
  echo "Installing Docker CLI..."
  case "$OS_ID" in
    ubuntu)
      apt-get update -qq && apt-get install -y --no-install-recommends docker.io
      # docker.io from Ubuntu default repos provides Docker CLI
      ;;
    amzn)
      dnf install -y -q docker
      ;;
  esac
  echo "Docker CLI installed"
}

# --- pip packages ---
install_pip_packages() {
  echo "Installing pip packages..."
  pip3 install --break-system-packages boto3 click 2>/dev/null \
    || pip3 install boto3 click
  # Note: MCP servers are installed via uvx at runtime, not pip
}

# --- Cleanup ---
cleanup() {
  case "$OS_ID" in
    ubuntu)
      apt-get clean
      rm -rf /var/lib/apt/lists/*
      ;;
    amzn)
      dnf clean all
      ;;
  esac
  rm -rf /tmp/*
}

# --- Execute ---
install_packages
create_user
install_nodejs
install_uv
install_awscli
install_codeserver
install_docker_cli
install_pip_packages
cleanup

echo "=== Common setup complete ==="
```

- [ ] **Step 2: Verify script is syntactically correct**

```bash
bash -n docker/devenv/scripts/setup-common.sh
echo $?  # Expected: 0
```

- [ ] **Step 3: Commit**

```bash
git add docker/devenv/scripts/setup-common.sh
git commit -m "feat: add devenv common setup script with Node.js, Python, AWS CLI, code-server"
```

---

### Task 3: Claude Code + Kiro Setup Scripts

**Files:**
- Create: `docker/devenv/scripts/setup-claude-code.sh`
- Create: `docker/devenv/scripts/setup-kiro.sh`
- Create: `docker/devenv/config/extensions.txt`

- [ ] **Step 1: Write Claude Code setup script**

Create: `docker/devenv/scripts/setup-claude-code.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== Setting up Claude Code ==="

# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code
NPM_PREFIX="$(npm prefix -g 2>/dev/null)"
if [ -n "$NPM_PREFIX" ] && [ -f "$NPM_PREFIX/bin/claude" ] && ! command -v claude &>/dev/null; then
  ln -sf "$NPM_PREFIX/bin/claude" /usr/local/bin/claude
fi
echo "Claude Code CLI $(claude --version 2>/dev/null || echo 'installed')"

# Install Claude Code VSCode extension
# Try marketplace first, fallback to Open VSX
sudo -u coder code-server --install-extension Anthropic.claude-code 2>/dev/null || {
  echo "Marketplace install failed, trying Open VSX..."
  VSIX_URL=$(curl -s "https://open-vsx.org/api/Anthropic/claude-code/latest" | jq -r '.files.download // empty')
  if [ -n "$VSIX_URL" ]; then
    curl -fsSL "$VSIX_URL" -o /tmp/claude-code.vsix
    sudo -u coder code-server --install-extension /tmp/claude-code.vsix
    rm -f /tmp/claude-code.vsix
  else
    echo "WARN: Claude Code extension not available, skipping"
  fi
}

# TODO: Claude Code plugin installation
# The plugin installation mechanism may vary by Claude Code version.
# Verify the correct CLI commands at build time:
#   claude plugins add <plugin-name>   (if supported)
#   claude mcp add <server-name>       (for MCP servers)
# Plugins and MCP servers are configured at runtime via entrypoint.sh
# because they need environment-specific endpoints (Bedrock region, etc.)

# uvx is bundled with uv (installed in setup-common.sh), no separate install needed
# Verify uvx is available
command -v uvx &>/dev/null || echo "WARN: uvx not found, MCP servers may not work"

echo "=== Claude Code setup complete ==="
```

- [ ] **Step 2: Write Kiro setup script**

Create: `docker/devenv/scripts/setup-kiro.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== Setting up Kiro CLI ==="

# TODO: Install Kiro CLI
# Kiro is an AWS product. Verify the correct package name at build time:
#   npm install -g @anthropic-ai/kiro   (or @aws/kiro-cli, or another name)
# Fallback: download binary from official release page
npm install -g kiro 2>/dev/null || {
  echo "WARN: Kiro CLI package name may have changed. Check https://kiro.dev for latest install instructions."
  echo "Continuing without Kiro CLI - install manually after container starts."
}

NPM_PREFIX="$(npm prefix -g 2>/dev/null)"
if [ -n "$NPM_PREFIX" ] && [ -f "$NPM_PREFIX/bin/kiro" ] && ! command -v kiro &>/dev/null; then
  ln -sf "$NPM_PREFIX/bin/kiro" /usr/local/bin/kiro
fi

# Kiro config directory
sudo -u coder mkdir -p /home/coder/.kiro/settings

echo "=== Kiro CLI setup complete ==="
```

- [ ] **Step 3: Write pre-approved extensions list**

Create: `docker/devenv/config/extensions.txt`

```
# Pre-approved VSCode extensions for CC-on-Bedrock devenv
# One extension ID per line
Anthropic.claude-code
ms-python.python
ms-python.vscode-pylance
dbaeumer.vscode-eslint
esbenp.prettier-vscode
eamodio.gitlens
hashicorp.terraform
amazonwebservices.aws-toolkit-vscode
redhat.vscode-yaml
ms-azuretools.vscode-docker
bradlc.vscode-tailwindcss
```

- [ ] **Step 4: Verify scripts are syntactically correct**

```bash
bash -n docker/devenv/scripts/setup-claude-code.sh && echo "OK" || echo "FAIL"
bash -n docker/devenv/scripts/setup-kiro.sh && echo "OK" || echo "FAIL"
```

- [ ] **Step 5: Commit**

```bash
git add docker/devenv/scripts/setup-claude-code.sh docker/devenv/scripts/setup-kiro.sh docker/devenv/config/extensions.txt
git commit -m "feat: add Claude Code and Kiro CLI setup scripts with extension list"
```

---

### Task 4: Devenv Entrypoint + Idle Monitor

**Files:**
- Create: `docker/devenv/scripts/entrypoint.sh`
- Create: `docker/devenv/scripts/idle-monitor.sh`
- Create: `docker/devenv/config/settings.json`

- [ ] **Step 1: Write entrypoint script (with DLP security policy)**

Create: `docker/devenv/scripts/entrypoint.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== CC-on-Bedrock Devenv Container Starting ==="

USER_HOME="/home/coder"
SECURITY_POLICY="${SECURITY_POLICY:-open}"

# --- EFS directory setup ---
if [ -d "$USER_HOME/workspace" ]; then
  echo "EFS workspace already mounted"
else
  mkdir -p "$USER_HOME/workspace"
fi

# Ensure correct ownership
chown -R coder:coder "$USER_HOME"

# --- Ensure .bashrc.d directory exists ---
sudo -u coder mkdir -p "$USER_HOME/.bashrc.d"

# --- Configure Claude Code for Bedrock via LiteLLM ---
if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  cat > "$USER_HOME/.bashrc.d/claude-env.sh" << ENVEOF
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export CLAUDE_CODE_USE_BEDROCK=1
ENVEOF
  chown coder:coder "$USER_HOME/.bashrc.d/claude-env.sh"
fi

# --- Configure Kiro for Bedrock ---
sudo -u coder mkdir -p "$USER_HOME/.kiro/settings"
cat > "$USER_HOME/.kiro/settings/bedrock.json" << KIROEOF
{
  "aws_region": "${AWS_DEFAULT_REGION:-ap-northeast-2}",
  "bearer_token": "${AWS_BEARER_TOKEN_BEDROCK:-}"
}
KIROEOF
chown coder:coder "$USER_HOME/.kiro/settings/bedrock.json"

# --- MCP Server Configuration ---
sudo -u coder mkdir -p "$USER_HOME/.claude"
cat > "$USER_HOME/.claude/mcp_servers.json" << MCPEOF
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
chown coder:coder "$USER_HOME/.claude/mcp_servers.json"

# --- Security Policy: code-server flags ---
CODESERVER_FLAGS=""
case "$SECURITY_POLICY" in
  restricted)
    echo "Applying RESTRICTED security policy"
    CODESERVER_FLAGS="--disable-file-downloads --disable-file-uploads"
    # Use pre-approved extensions only
    if [ -d /opt/extensions-approved ]; then
      CODESERVER_FLAGS="$CODESERVER_FLAGS --extensions-dir /opt/extensions-approved"
    fi
    ;;
  locked)
    echo "Applying LOCKED security policy"
    CODESERVER_FLAGS="--disable-file-downloads --disable-file-uploads"
    # Read-only extensions
    if [ -d /opt/extensions-readonly ]; then
      CODESERVER_FLAGS="$CODESERVER_FLAGS --extensions-dir /opt/extensions-readonly"
    fi
    ;;
  *)
    echo "Applying OPEN security policy"
    ;;
esac

# --- Copy default VSCode settings if not exists ---
if [ ! -f "$USER_HOME/.local/share/code-server/User/settings.json" ]; then
  sudo -u coder mkdir -p "$USER_HOME/.local/share/code-server/User"
  cp /opt/devenv/config/settings.json "$USER_HOME/.local/share/code-server/User/settings.json"
  chown coder:coder "$USER_HOME/.local/share/code-server/User/settings.json"
fi

# --- Ensure .bashrc.d sourcing ---
sudo -u coder bash -c "
  mkdir -p $USER_HOME/.bashrc.d
  if ! grep -q 'bashrc.d' $USER_HOME/.bashrc 2>/dev/null; then
    echo 'for f in ~/.bashrc.d/*.sh; do [ -r \"\$f\" ] && source \"\$f\"; done' >> $USER_HOME/.bashrc
  fi
"

# --- Start idle monitor in background ---
/opt/devenv/scripts/idle-monitor.sh &

# --- Start code-server ---
echo "Starting code-server with flags: $CODESERVER_FLAGS"
exec sudo -u coder \
  PASSWORD="${CODESERVER_PASSWORD:-}" \
  code-server \
  --bind-addr 0.0.0.0:8080 \
  --auth "${CODESERVER_AUTH:-password}" \
  --user-data-dir "$USER_HOME/.local/share/code-server" \
  $CODESERVER_FLAGS \
  "$USER_HOME/workspace"
```

- [ ] **Step 2: Write idle monitor script**

Create: `docker/devenv/scripts/idle-monitor.sh`

```bash
#!/bin/bash
# Monitors code-server idle status and writes metric for CloudWatch
# Auto-timeout handled by external Lambda that reads this metric

IDLE_THRESHOLD_SECONDS="${IDLE_TIMEOUT_SECONDS:-7200}"  # 2 hours default
METRIC_FILE="/tmp/idle-status"

while true; do
  sleep 60

  # Check code-server active connections
  ACTIVE_CONNECTIONS=$(curl -s http://localhost:8080/healthz 2>/dev/null | grep -c "alive" || echo "0")

  # Check recent terminal activity (pty writes in last 5 min)
  RECENT_ACTIVITY=$(find /home/coder -name "*.pty" -mmin -5 2>/dev/null | wc -l)

  # Check CPU usage of coder user processes
  CPU_USAGE=$(ps -u coder -o pcpu= 2>/dev/null | awk '{sum+=$1} END {printf "%.0f", sum}')

  if [ "${ACTIVE_CONNECTIONS:-0}" -eq 0 ] && [ "${RECENT_ACTIVITY:-0}" -eq 0 ] && [ "${CPU_USAGE:-0}" -lt 5 ]; then
    # Increment idle counter
    IDLE_COUNT=$(cat "$METRIC_FILE" 2>/dev/null || echo "0")
    IDLE_COUNT=$((IDLE_COUNT + 1))
    echo "$IDLE_COUNT" > "$METRIC_FILE"

    IDLE_MINUTES=$((IDLE_COUNT))
    echo "Container idle for ${IDLE_MINUTES} minutes (threshold: $((IDLE_THRESHOLD_SECONDS / 60)) min)"
  else
    echo "0" > "$METRIC_FILE"
  fi
done
```

- [ ] **Step 3: Write default VSCode settings**

Create: `docker/devenv/config/settings.json`

```json
{
  "workbench.colorTheme": "Default Dark+",
  "editor.fontSize": 14,
  "editor.tabSize": 2,
  "editor.formatOnSave": true,
  "editor.minimap.enabled": false,
  "terminal.integrated.defaultProfile.linux": "bash",
  "files.autoSave": "afterDelay",
  "files.autoSaveDelay": 1000,
  "git.autofetch": true,
  "extensions.autoUpdate": false,
  "telemetry.telemetryLevel": "off"
}
```

- [ ] **Step 4: Verify scripts**

```bash
bash -n docker/devenv/scripts/entrypoint.sh && echo "OK" || echo "FAIL"
bash -n docker/devenv/scripts/idle-monitor.sh && echo "OK" || echo "FAIL"
python3 -m json.tool docker/devenv/config/settings.json > /dev/null && echo "JSON OK" || echo "JSON FAIL"
```

- [ ] **Step 5: Commit**

```bash
git add docker/devenv/scripts/entrypoint.sh docker/devenv/scripts/idle-monitor.sh docker/devenv/config/settings.json
git commit -m "feat: add devenv entrypoint with DLP security policy and idle monitor"
```

---

### Task 5: Devenv Dockerfiles (Ubuntu + AL2023)

**Files:**
- Create: `docker/devenv/Dockerfile.ubuntu`
- Create: `docker/devenv/Dockerfile.al2023`

- [ ] **Step 1: Write .dockerignore**

Create: `docker/devenv/.dockerignore`

```
.git
*.md
LICENSE
```

- [ ] **Step 2: Write Ubuntu Dockerfile**

Create: `docker/devenv/Dockerfile.ubuntu`

```dockerfile
FROM ubuntu:24.04

LABEL maintainer="cc-on-bedrock"
LABEL description="CC-on-Bedrock Development Environment (Ubuntu 24.04 ARM64)"

ARG TARGETARCH=arm64

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Copy scripts and config
COPY scripts/ /opt/devenv/scripts/
COPY config/ /opt/devenv/config/
RUN chmod +x /opt/devenv/scripts/*.sh

# Run common setup (Node.js, Python, AWS CLI, code-server, etc.)
RUN /opt/devenv/scripts/setup-common.sh

# Install Claude Code + plugins
RUN /opt/devenv/scripts/setup-claude-code.sh

# Install Kiro CLI
RUN /opt/devenv/scripts/setup-kiro.sh

# Pre-install approved extensions
RUN while IFS= read -r ext || [ -n "$ext" ]; do \
      ext=$(echo "$ext" | sed 's/#.*//;s/^[[:space:]]*//;s/[[:space:]]*$//'); \
      [ -z "$ext" ] && continue; \
      sudo -u coder code-server --install-extension "$ext" 2>/dev/null || \
        echo "WARN: Could not install extension $ext"; \
    done < /opt/devenv/config/extensions.txt

# Copy approved extensions for restricted/locked modes
RUN cp -r /home/coder/.local/share/code-server/extensions /opt/extensions-approved 2>/dev/null || true \
    && cp -r /home/coder/.local/share/code-server/extensions /opt/extensions-readonly 2>/dev/null || true

# Expose code-server port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/healthz || exit 1

ENTRYPOINT ["/opt/devenv/scripts/entrypoint.sh"]
```

- [ ] **Step 2: Write Amazon Linux 2023 Dockerfile**

Create: `docker/devenv/Dockerfile.al2023`

```dockerfile
FROM amazonlinux:2023

LABEL maintainer="cc-on-bedrock"
LABEL description="CC-on-Bedrock Development Environment (Amazon Linux 2023 ARM64)"

ARG TARGETARCH=arm64

# Copy scripts and config
COPY scripts/ /opt/devenv/scripts/
COPY config/ /opt/devenv/config/
RUN chmod +x /opt/devenv/scripts/*.sh

# Run common setup (Node.js, Python, AWS CLI, code-server, etc.)
RUN /opt/devenv/scripts/setup-common.sh

# Install Claude Code + plugins
RUN /opt/devenv/scripts/setup-claude-code.sh

# Install Kiro CLI
RUN /opt/devenv/scripts/setup-kiro.sh

# Pre-install approved extensions
RUN while IFS= read -r ext || [ -n "$ext" ]; do \
      ext=$(echo "$ext" | sed 's/#.*//;s/^[[:space:]]*//;s/[[:space:]]*$//'); \
      [ -z "$ext" ] && continue; \
      sudo -u coder code-server --install-extension "$ext" 2>/dev/null || \
        echo "WARN: Could not install extension $ext"; \
    done < /opt/devenv/config/extensions.txt

# Copy approved extensions for restricted/locked modes
RUN cp -r /home/coder/.local/share/code-server/extensions /opt/extensions-approved 2>/dev/null || true \
    && cp -r /home/coder/.local/share/code-server/extensions /opt/extensions-readonly 2>/dev/null || true

# Expose code-server port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/healthz || exit 1

ENTRYPOINT ["/opt/devenv/scripts/entrypoint.sh"]
```

- [ ] **Step 3: Commit**

```bash
git add docker/devenv/Dockerfile.ubuntu docker/devenv/Dockerfile.al2023
git commit -m "feat: add devenv Dockerfiles for Ubuntu 24.04 and Amazon Linux 2023"
```

---

### Task 6: LiteLLM Docker Image

**Files:**
- Create: `docker/litellm/Dockerfile`
- Create: `docker/litellm/litellm-config.yaml`
- Create: `docker/litellm/scripts/entrypoint.sh`

- [ ] **Step 1: Write LiteLLM config template**

Create: `docker/litellm/litellm-config.yaml`

```yaml
model_list:
  - model_name: "claude-opus-4-6"
    litellm_params:
      model: "bedrock/global.anthropic.claude-opus-4-6-v1[1m]"
      aws_region_name: "ap-northeast-2"
  - model_name: "claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/global.anthropic.claude-sonnet-4-6[1m]"
      aws_region_name: "ap-northeast-2"

router_settings:
  redis_host: "${REDIS_HOST}"
  redis_port: 6380
  redis_password: "${REDIS_PASSWORD}"
  redis_ssl: true

general_settings:
  master_key: "${LITELLM_MASTER_KEY}"
  database_url: "${DATABASE_URL}"
  use_redis_transaction_buffer: true

litellm_settings:
  cache: true
  cache_params:
    type: redis
    host: "${REDIS_HOST}"
    port: 6380
    ssl: true
  drop_params: true
```

- [ ] **Step 2: Write LiteLLM entrypoint script**

Create: `docker/litellm/scripts/entrypoint.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== CC-on-Bedrock LiteLLM Proxy Starting ==="

CONFIG_FILE="/app/litellm-config.yaml"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"

# --- Fetch secrets from Secrets Manager (if ARNs provided) ---
fetch_secret() {
  local secret_id="$1"
  aws secretsmanager get-secret-value \
    --secret-id "$secret_id" \
    --region "$REGION" \
    --query 'SecretString' \
    --output text 2>/dev/null
}

if [ -n "${LITELLM_MASTER_KEY_SECRET_ARN:-}" ]; then
  export LITELLM_MASTER_KEY=$(fetch_secret "$LITELLM_MASTER_KEY_SECRET_ARN")
  echo "Fetched master key from Secrets Manager"
fi

if [ -n "${RDS_CREDENTIALS_SECRET_ARN:-}" ]; then
  RDS_CREDS=$(fetch_secret "$RDS_CREDENTIALS_SECRET_ARN")
  DB_USER=$(echo "$RDS_CREDS" | jq -r '.username')
  DB_PASS=$(echo "$RDS_CREDS" | jq -r '.password')
  DB_HOST=$(echo "$RDS_CREDS" | jq -r '.host')
  DB_PORT=$(echo "$RDS_CREDS" | jq -r '.port // "5432"')
  DB_NAME=$(echo "$RDS_CREDS" | jq -r '.dbname // "litellm"')
  export DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  echo "Fetched RDS credentials from Secrets Manager"
fi

if [ -n "${VALKEY_AUTH_SECRET_ARN:-}" ]; then
  export REDIS_PASSWORD=$(fetch_secret "$VALKEY_AUTH_SECRET_ARN")
  echo "Fetched Valkey auth from Secrets Manager"
fi

# --- Substitute environment variables in config ---
envsubst < "$CONFIG_FILE" > /tmp/litellm-config-resolved.yaml

echo "Starting LiteLLM proxy..."
exec litellm \
  --config /tmp/litellm-config-resolved.yaml \
  --port 4000 \
  --host 0.0.0.0 \
  --num_workers 4
```

- [ ] **Step 3: Write LiteLLM Dockerfile**

Create: `docker/litellm/Dockerfile`

```dockerfile
FROM ghcr.io/berriai/litellm:main

LABEL maintainer="cc-on-bedrock"
LABEL description="CC-on-Bedrock LiteLLM Proxy with Bedrock integration"

USER root

# Install envsubst (gettext) and jq for config templating + secret parsing
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends gettext-base jq curl unzip && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 for Secrets Manager access
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip; \
    else \
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip; \
    fi && \
    unzip -q /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/aws /tmp/awscliv2.zip

# Copy config and entrypoint
COPY litellm-config.yaml /app/litellm-config.yaml
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:4000/health/liveness || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
```

- [ ] **Step 4: Commit**

```bash
git add docker/litellm/
git commit -m "feat: add LiteLLM proxy Docker image with Secrets Manager integration"
```

---

### Task 7: Build Script + Local Test

**Files:**
- Create: `docker/build.sh`

- [ ] **Step 1: Write build and push script**

Create: `docker/build.sh`

```bash
#!/bin/bash
set -euo pipefail

# Usage: ./build.sh [build|push|all] [devenv-ubuntu|devenv-al2023|litellm|all]
ACTION="${1:-build}"
TARGET="${2:-all}"
REGION="${AWS_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "000000000000")
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${IMAGE_TAG:-latest}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

build_image() {
  local name="$1"
  local dockerfile="$2"
  local context="$3"
  local ecr_repo="$4"
  local image_tag="$5"

  echo "=== Building $name (tag: $image_tag) ==="
  docker build \
    --platform linux/arm64 \
    -f "$dockerfile" \
    -t "${ecr_repo}:${image_tag}" \
    -t "${ECR_REGISTRY}/${ecr_repo}:${image_tag}" \
    "$context"
  echo "=== Built $name ==="
}

push_image() {
  local ecr_repo="$1"
  local image_tag="$2"

  echo "=== Pushing $ecr_repo:$image_tag ==="
  aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "$ECR_REGISTRY"
  docker push "${ECR_REGISTRY}/${ecr_repo}:${image_tag}"
  echo "=== Pushed $ecr_repo:$image_tag ==="
}

# Build targets
do_build() {
  case "$TARGET" in
    devenv-ubuntu)
      build_image "devenv-ubuntu" "$SCRIPT_DIR/devenv/Dockerfile.ubuntu" "$SCRIPT_DIR/devenv" "cc-on-bedrock/devenv" "ubuntu-${TAG}" ;;
    devenv-al2023)
      build_image "devenv-al2023" "$SCRIPT_DIR/devenv/Dockerfile.al2023" "$SCRIPT_DIR/devenv" "cc-on-bedrock/devenv" "al2023-${TAG}" ;;
    litellm)
      build_image "litellm" "$SCRIPT_DIR/litellm/Dockerfile" "$SCRIPT_DIR/litellm" "cc-on-bedrock/litellm" "$TAG" ;;
    all)
      build_image "devenv-ubuntu" "$SCRIPT_DIR/devenv/Dockerfile.ubuntu" "$SCRIPT_DIR/devenv" "cc-on-bedrock/devenv" "ubuntu-${TAG}"
      build_image "devenv-al2023" "$SCRIPT_DIR/devenv/Dockerfile.al2023" "$SCRIPT_DIR/devenv" "cc-on-bedrock/devenv" "al2023-${TAG}"
      build_image "litellm" "$SCRIPT_DIR/litellm/Dockerfile" "$SCRIPT_DIR/litellm" "cc-on-bedrock/litellm" "$TAG"
      ;;
  esac
}

do_push() {
  case "$TARGET" in
    devenv-ubuntu)
      push_image "cc-on-bedrock/devenv" "ubuntu-${TAG}" ;;
    devenv-al2023)
      push_image "cc-on-bedrock/devenv" "al2023-${TAG}" ;;
    litellm)
      push_image "cc-on-bedrock/litellm" "$TAG" ;;
    all)
      push_image "cc-on-bedrock/devenv" "ubuntu-${TAG}"
      push_image "cc-on-bedrock/devenv" "al2023-${TAG}"
      push_image "cc-on-bedrock/litellm" "$TAG"
      ;;
  esac
}

case "$ACTION" in
  build) do_build ;;
  push) do_push ;;
  all) do_build && do_push ;;
  *) echo "Usage: $0 [build|push|all] [devenv-ubuntu|devenv-al2023|litellm|all]"; exit 1 ;;
esac

echo "=== Done ==="
```

- [ ] **Step 2: Make scripts executable**

```bash
chmod +x docker/build.sh
chmod +x scripts/create-ecr-repos.sh
chmod +x docker/devenv/scripts/*.sh
chmod +x docker/litellm/scripts/*.sh
```

- [ ] **Step 3: Local build test (Ubuntu devenv)**

```bash
cd /home/ec2-user/my-project/cc-on-bedrock
docker build --platform linux/arm64 -f docker/devenv/Dockerfile.ubuntu -t devenv-test:ubuntu docker/devenv/
# Expected: successful build
```

- [ ] **Step 4: Local build test (LiteLLM)**

```bash
docker build --platform linux/arm64 -f docker/litellm/Dockerfile -t litellm-test:latest docker/litellm/
# Expected: successful build
```

- [ ] **Step 5: Verify container starts**

```bash
# Test devenv container starts and code-server responds
docker run -d --name devenv-test -p 8080:8080 -e SECURITY_POLICY=open -e CODESERVER_AUTH=none devenv-test:ubuntu
sleep 10
curl -s http://localhost:8080/healthz && echo "DEVENV OK" || echo "DEVENV FAIL"
docker stop devenv-test && docker rm devenv-test

# Test litellm container starts (will fail on DB connection but should start)
docker run -d --name litellm-test -p 4000:4000 \
  -e LITELLM_MASTER_KEY=sk-test \
  -e DATABASE_URL=postgresql://test:test@localhost:5432/test \
  -e REDIS_HOST=localhost \
  -e REDIS_PASSWORD=test \
  litellm-test:latest
sleep 5
docker logs litellm-test 2>&1 | head -20
docker stop litellm-test && docker rm litellm-test
```

- [ ] **Step 6: Commit**

```bash
git add docker/build.sh scripts/create-ecr-repos.sh
git commit -m "feat: add Docker build/push script and ECR repo creation script"
```

---

### Task 8: Container Integration Tests

**Files:**
- Create: `tests/docker/test-scripts.sh`
- Create: `tests/docker/test-devenv.sh`
- Create: `tests/docker/test-litellm.sh`

- [ ] **Step 1: Write shell script lint tests**

Create: `tests/docker/test-scripts.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== Shell Script Lint Tests ==="
FAIL=0

# Install shellcheck if not present
command -v shellcheck &>/dev/null || {
  echo "Installing shellcheck..."
  apt-get update -qq && apt-get install -y shellcheck 2>/dev/null || \
    dnf install -y shellcheck 2>/dev/null || \
    echo "WARN: shellcheck not available, skipping lint"
  }

if command -v shellcheck &>/dev/null; then
  for script in docker/devenv/scripts/*.sh docker/litellm/scripts/*.sh scripts/*.sh docker/build.sh; do
    [ -f "$script" ] || continue
    echo "Checking $script..."
    if shellcheck -S warning "$script"; then
      echo "  PASS"
    else
      echo "  FAIL"
      FAIL=1
    fi
  done
else
  echo "SKIP: shellcheck not installed"
fi

echo "=== Lint tests complete (failures: $FAIL) ==="
exit $FAIL
```

- [ ] **Step 2: Write devenv container integration test**

Create: `tests/docker/test-devenv.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== Devenv Container Integration Tests ==="
IMAGE="${1:-cc-on-bedrock/devenv:ubuntu-latest}"
CONTAINER_NAME="devenv-integration-test"
FAIL=0

cleanup() {
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

# Start container
echo "Starting container from $IMAGE..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p 18080:8080 \
  -e SECURITY_POLICY=open \
  -e CODESERVER_AUTH=none \
  -e AWS_DEFAULT_REGION=ap-northeast-2 \
  "$IMAGE"

echo "Waiting for code-server to start..."
sleep 15

# Test 1: code-server is running
echo -n "Test 1 - code-server health: "
if curl -sf http://localhost:18080/healthz > /dev/null 2>&1; then
  echo "PASS"
else
  echo "FAIL"; FAIL=1
fi

# Test 2: Required binaries exist
for bin in node npm python3 aws git curl jq code-server; do
  echo -n "Test 2 - binary '$bin': "
  if docker exec "$CONTAINER_NAME" which "$bin" > /dev/null 2>&1; then
    echo "PASS"
  else
    echo "FAIL"; FAIL=1
  fi
done

# Test 3: Claude Code CLI
echo -n "Test 3 - claude CLI: "
if docker exec "$CONTAINER_NAME" which claude > /dev/null 2>&1; then
  echo "PASS"
else
  echo "WARN (may need manual install)"; # Not a hard fail
fi

# Test 4: Node.js version
echo -n "Test 4 - Node.js v20: "
NODE_VER=$(docker exec "$CONTAINER_NAME" node --version 2>/dev/null || echo "none")
if [[ "$NODE_VER" == v20.* ]]; then
  echo "PASS ($NODE_VER)"
else
  echo "FAIL ($NODE_VER)"; FAIL=1
fi

# Test 5: coder user exists
echo -n "Test 5 - coder user: "
if docker exec "$CONTAINER_NAME" id coder > /dev/null 2>&1; then
  echo "PASS"
else
  echo "FAIL"; FAIL=1
fi

# Test 6: Security policy - restricted mode
echo "Test 6 - restricted security policy:"
cleanup
docker run -d \
  --name "$CONTAINER_NAME" \
  -p 18080:8080 \
  -e SECURITY_POLICY=restricted \
  -e CODESERVER_AUTH=none \
  "$IMAGE"
sleep 10
echo -n "  container starts in restricted mode: "
if docker exec "$CONTAINER_NAME" ps aux | grep -q code-server; then
  echo "PASS"
else
  echo "FAIL"; FAIL=1
fi

echo "=== Devenv tests complete (failures: $FAIL) ==="
exit $FAIL
```

- [ ] **Step 3: Write LiteLLM container integration test**

Create: `tests/docker/test-litellm.sh`

```bash
#!/bin/bash
set -euo pipefail

echo "=== LiteLLM Container Integration Tests ==="
IMAGE="${1:-cc-on-bedrock/litellm:latest}"
CONTAINER_NAME="litellm-integration-test"
FAIL=0

cleanup() {
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

# Start container (will fail on DB but entrypoint should work)
echo "Starting container from $IMAGE..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p 14000:4000 \
  -e LITELLM_MASTER_KEY=sk-test-key \
  -e DATABASE_URL=postgresql://test:test@localhost:5432/test \
  -e REDIS_HOST=localhost \
  -e REDIS_PASSWORD=test \
  "$IMAGE"

sleep 10

# Test 1: Required binaries
for bin in aws jq envsubst; do
  echo -n "Test 1 - binary '$bin': "
  if docker exec "$CONTAINER_NAME" which "$bin" > /dev/null 2>&1; then
    echo "PASS"
  else
    echo "FAIL"; FAIL=1
  fi
done

# Test 2: Config template was resolved
echo -n "Test 2 - config resolved: "
if docker exec "$CONTAINER_NAME" cat /tmp/litellm-config-resolved.yaml 2>/dev/null | grep -q "sk-test-key"; then
  echo "PASS (master_key substituted)"
else
  echo "FAIL (envsubst may not have run)"; FAIL=1
fi

# Test 3: Entrypoint ran (check logs)
echo -n "Test 3 - entrypoint executed: "
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "CC-on-Bedrock LiteLLM Proxy Starting"; then
  echo "PASS"
else
  echo "FAIL"; FAIL=1
fi

echo "=== LiteLLM tests complete (failures: $FAIL) ==="
exit $FAIL
```

- [ ] **Step 4: Make test scripts executable**

```bash
mkdir -p tests/docker
chmod +x tests/docker/*.sh
```

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: add container integration tests for devenv and litellm images"
```

---

### Task 9: .gitignore + README

**Files:**
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Write .gitignore**

Create: `.gitignore`

```
# Node
node_modules/
.next/
dist/

# Python
__pycache__/
*.pyc
.venv/

# CDK
cdk/cdk.out/
cdk/node_modules/

# Terraform
terraform/.terraform/
terraform/*.tfstate*
terraform/.terraform.lock.hcl

# IDE
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db

# Secrets
*.env
*.pem
*.key

# Docker
docker/devenv/scripts/__pycache__/
```

- [ ] **Step 2: Write README**

Create: `README.md`

```markdown
# CC-on-Bedrock

AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼.

CDK(TypeScript), Terraform(HCL), CloudFormation(YAML) 3가지 IaC로 동일 아키텍처를 배포합니다.

## Architecture

- **LiteLLM Proxy:** EC2 ASG x2 → Bedrock (Opus 4.6 / Sonnet 4.6)
- **ECS Dev Environment:** code-server + Claude Code + Kiro (Ubuntu/AL2023 선택)
- **Next.js Dashboard:** 사용자 관리, 사용량 분석, 컨테이너 제어
- **Authentication:** Amazon Cognito
- **Region:** ap-northeast-2 (Seoul)

## Quick Start

### 1. Docker Images

```bash
# Create ECR repositories
bash scripts/create-ecr-repos.sh

# Build and push all images
cd docker && bash build.sh all all
```

### 2. Deploy Infrastructure

Choose one of:

```bash
# CDK
cd cdk && npm install && cdk deploy --all

# Terraform
cd terraform && terraform init && terraform apply

# CloudFormation
cd cloudformation && bash deploy.sh
```

## Documentation

- [Architecture Design Spec](docs/superpowers/specs/2026-03-19-cc-on-bedrock-design.md)
- [Implementation Plans](docs/superpowers/plans/)

## License

MIT
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore README.md
git commit -m "chore: add .gitignore and project README"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Project scaffolding | directories, `create-ecr-repos.sh` |
| 2 | Common setup script | `setup-common.sh` |
| 3 | Claude Code + Kiro scripts | `setup-claude-code.sh`, `setup-kiro.sh`, `extensions.txt` |
| 4 | Entrypoint + idle monitor | `entrypoint.sh`, `idle-monitor.sh`, `settings.json` |
| 5 | Devenv Dockerfiles | `Dockerfile.ubuntu`, `Dockerfile.al2023` |
| 6 | LiteLLM Docker image | `Dockerfile`, `litellm-config.yaml`, `entrypoint.sh` |
| 7 | Build script + local build | `build.sh`, local verification |
| 8 | Container integration tests | `test-scripts.sh`, `test-devenv.sh`, `test-litellm.sh` |
| 9 | .gitignore + README | `.gitignore`, `README.md` |
