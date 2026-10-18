#!/bin/bash
set -euo pipefail

echo "=== Setting up Codex CLI (ADR-014: Codex on Bedrock) ==="

# OpenAI Codex CLI — talks to Amazon Bedrock (bedrock-runtime Responses API) via
# the AWS SDK credential chain; no OpenAI account or API key is used.
npm install -g @openai/codex || {
  echo "WARN: Codex CLI install failed. It is retried on every boot by cc-cli-update.service."
}

NPM_PREFIX="$(npm prefix -g 2>/dev/null)"
if [ -n "$NPM_PREFIX" ] && [ -f "$NPM_PREFIX/bin/codex" ] && ! command -v codex &>/dev/null; then
  ln -sf "$NPM_PREFIX/bin/codex" /usr/local/bin/codex
fi
echo "Codex CLI $(codex --version 2>/dev/null || echo 'not installed')"

# Governed provider/model/region are written per instance (region-specific) to the
# system layer /etc/codex/config.toml by DevEnv user-data (ec2-clients.ts) or the
# container entrypoint. Only the per-user state dir is created here.
if id coder &>/dev/null; then
  sudo -u coder mkdir -p /home/coder/.codex
fi

echo "=== Codex CLI setup complete ==="
