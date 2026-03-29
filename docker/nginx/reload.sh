#!/bin/bash
# Nginx config reload script for CC-on-Bedrock
# Downloads config from S3 before starting Nginx, then polls every 5s for updates

set -e

CONFIG_BUCKET="${CONFIG_BUCKET:-${S3_BUCKET:-}}"
CONFIG_KEY="${CONFIG_KEY:-${S3_CONFIG_KEY:-nginx/nginx.conf}}"
LOCAL_CONFIG="/etc/nginx/nginx.conf"
TEMP_CONFIG="/tmp/nginx.conf.new"
RELOAD_INTERVAL="${RELOAD_INTERVAL:-5}"
LAST_ETAG=""

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Download config from S3 if changed
download_config() {
    if [ -z "$CONFIG_BUCKET" ]; then
        log "CONFIG_BUCKET not set, skipping S3 sync"
        return 1
    fi

    # Get current ETag (log errors for debugging)
    local head_err="/tmp/s3-head-err.log"
    CURRENT_ETAG=$(aws s3api head-object \
        --bucket "$CONFIG_BUCKET" \
        --key "$CONFIG_KEY" \
        --query 'ETag' \
        --output text 2>"$head_err" || echo "")

    if [ -z "$CURRENT_ETAG" ]; then
        local err_msg=$(cat "$head_err" 2>/dev/null | head -3)
        log "Config not found in S3: s3://$CONFIG_BUCKET/$CONFIG_KEY (error: $err_msg)"
        return 1
    fi

    # Check if config changed
    if [ "$CURRENT_ETAG" = "$LAST_ETAG" ]; then
        return 1
    fi

    log "Config changed (ETag: $CURRENT_ETAG), downloading..."

    if aws s3 cp "s3://$CONFIG_BUCKET/$CONFIG_KEY" "$TEMP_CONFIG" --quiet; then
        LAST_ETAG="$CURRENT_ETAG"
        return 0
    else
        log "Failed to download config from S3"
        return 1
    fi
}

# Validate and apply config (used for initial download and reloads)
apply_config() {
    if [ ! -f "$TEMP_CONFIG" ]; then
        return 1
    fi

    log "Validating new config..."

    if nginx -t -c "$TEMP_CONFIG" 2>&1; then
        log "Config valid, applying..."
        cp "$TEMP_CONFIG" "$LOCAL_CONFIG"
        rm -f "$TEMP_CONFIG"
        return 0
    else
        log "Config validation failed, keeping current config"
        rm -f "$TEMP_CONFIG"
        return 1
    fi
}

# Reload running nginx with new config
reload_nginx() {
    if nginx -s reload 2>&1; then
        log "Nginx reloaded successfully"
        return 0
    else
        log "Failed to reload nginx"
        return 1
    fi
}

# Main
main() {
    log "Starting nginx config reload daemon"
    log "CONFIG_BUCKET: ${CONFIG_BUCKET:-not set}"
    log "CONFIG_KEY: $CONFIG_KEY"
    log "RELOAD_INTERVAL: ${RELOAD_INTERVAL}s"

    # Step 1: Download latest config from S3 before starting Nginx
    if download_config; then
        apply_config
        log "Initial config loaded from S3"
    else
        log "No S3 config available, starting with default config"
    fi

    # Step 2: Start nginx in background
    log "Starting nginx..."
    nginx -g 'daemon off;' &
    NGINX_PID=$!

    # Give nginx time to start
    sleep 2

    if ! kill -0 $NGINX_PID 2>/dev/null; then
        log "ERROR: Nginx failed to start"
        exit 1
    fi

    log "Nginx started (PID: $NGINX_PID)"

    # Step 3: Enter polling loop for config updates
    while true; do
        sleep "$RELOAD_INTERVAL"
        if download_config; then
            if apply_config; then
                reload_nginx
            fi
        fi
    done
}

# Handle signals
trap 'log "Shutting down..."; nginx -s quit; exit 0' SIGTERM SIGINT

main
