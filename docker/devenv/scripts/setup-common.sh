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
        openssh-client sudo locales iptables
      # Set locale
      locale-gen en_US.UTF-8
      ;;
    amzn)
      dnf update -y -q
      # Note: curl-minimal is pre-installed on AL2023, don't install curl (conflicts)
      dnf install -y -q \
        wget git jq unzip tar gzip ca-certificates \
        gcc gcc-c++ make python3 python3-pip iptables \
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
    # Force UID/GID 1001 for consistency across Ubuntu and AL2023
    # Ubuntu has 'ubuntu' at UID 1000, so coder gets 1001 naturally
    # AL2023 has no default user, so we must explicitly set 1001
    groupadd -g 1001 coder 2>/dev/null || true
    useradd -m -s /bin/bash -d /home/coder -u 1001 -g 1001 coder
    # Restricted sudo: coder can run code-server + package managers (no shell, no iptables)
    cat > /etc/sudoers.d/coder << 'SUDOEOF'
coder ALL=(root) NOPASSWD: /usr/bin/code-server
coder ALL=(root) NOPASSWD: /usr/local/bin/npm
coder ALL=(root) NOPASSWD: /usr/local/bin/npx
coder ALL=(root) NOPASSWD: /usr/bin/pip3
coder ALL=(root) NOPASSWD: /usr/bin/apt-get
coder ALL=(root) NOPASSWD: /usr/bin/dnf
coder ALL=(root) NOPASSWD: /usr/bin/yum
SUDOEOF
    chmod 0440 /etc/sudoers.d/coder
  fi
}

# --- Node.js 20 via binary download (Docker-friendly, no shell detection needed) ---
install_nodejs() {
  echo "Installing Node.js 20..."
  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ]; then
    NODE_ARCH="arm64"
  else
    NODE_ARCH="x64"
  fi
  NODE_VERSION="v20.18.3"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz
  tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1
  rm /tmp/node.tar.gz
  echo "Node.js $(node --version) installed"
}

# --- Python uv (pinned version) ---
install_uv() {
  echo "Installing uv..."
  UV_VERSION="0.6.12"
  curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env CARGO_HOME=/usr/local sh
  # Ensure uv is on PATH for all users
  ln -sf /root/.local/bin/uv /usr/local/bin/uv 2>/dev/null || true
  echo "uv $(uv --version) installed"
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

# --- code-server (pinned version) ---
install_codeserver() {
  echo "Installing code-server..."
  CODESERVER_VERSION="4.96.4"
  curl -fsSL "https://code-server.dev/install.sh" | sh -s -- --version="${CODESERVER_VERSION}"
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
