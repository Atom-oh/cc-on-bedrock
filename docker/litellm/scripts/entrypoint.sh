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
