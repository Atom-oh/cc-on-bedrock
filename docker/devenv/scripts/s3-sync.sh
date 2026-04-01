#!/bin/bash
# S3 Sync Script for CC-on-Bedrock container workspace
#
# Usage: s3-sync.sh <action> [options]
# Actions:
#   restore     - Download from S3 to local workspace (container start)
#   sync        - Incremental sync changed files only (5-min cron)
#   full-backup - Full sync with --delete flag (container stop)
#
# Environment variables:
#   S3_SYNC_BUCKET  - S3 bucket name (required)
#   USER_SUBDOMAIN  - User identifier (required)
#
# Sync scope: /home/coder/ (full home, excluding caches)

set -euo pipefail

# Configuration — sync entire home directory for dotfile preservation
SYNC_ROOT="/home/coder"
WORKSPACE="/home/coder/workspace"
METADATA_FILE="$WORKSPACE/.metadata.json"
LOG_PREFIX="[s3-sync]"
S3_BUCKET="${S3_SYNC_BUCKET:-}"
USER_ID="${USER_SUBDOMAIN:-}"

# Exclude patterns for sync (caches + regenerable artifacts)
EXCLUDE_PATTERNS=(
    "node_modules/*"
    ".git/objects/*"
    "build/*"
    "dist/*"
    "__pycache__/*"
    ".cache/*"
    "*.log"
    ".npm/*"
    ".pnpm-store/*"
    "target/*"
    "*.pyc"
    ".mypy_cache/*"
    ".pytest_cache/*"
    "coverage/*"
    ".next/*"
    ".nuxt/*"
    ".venv/*"
    "venv/*"
    ".tox/*"
    ".local/share/code-server/CachedExtensionVSIXs/*"
    ".local/share/code-server/coder-logs/*"
    ".config/code-server/config.yaml"
)

log() {
    echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $1"
}

error() {
    log "ERROR: $1" >&2
    exit 1
}

validate_env() {
    if [ -z "$S3_BUCKET" ]; then
        error "S3_SYNC_BUCKET environment variable is not set"
    fi
    if [ -z "$USER_ID" ]; then
        error "USER_SUBDOMAIN environment variable is not set"
    fi
}

get_s3_path() {
    echo "s3://$S3_BUCKET/users/$USER_ID/home/"
}

build_exclude_args() {
    local args=""
    for pattern in "${EXCLUDE_PATTERNS[@]}"; do
        args="$args --exclude '$pattern'"
    done
    echo "$args"
}

update_metadata() {
    local action=$1
    local status=$2
    local timestamp
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

    cat > "$METADATA_FILE" << EOF
{
    "user_id": "$USER_ID",
    "last_sync": "$timestamp",
    "last_action": "$action",
    "status": "$status",
    "s3_bucket": "$S3_BUCKET",
    "s3_path": "users/$USER_ID/home/"
}
EOF
    chown coder:coder "$METADATA_FILE" 2>/dev/null || true
}

# Action: restore
# Download from S3 to local workspace at container start
do_restore() {
    log "Starting restore from S3..."
    validate_env

    local s3_path
    s3_path=$(get_s3_path)

    # Ensure directories exist
    mkdir -p "$WORKSPACE"

    # Check if S3 path exists (has any objects)
    if ! aws s3 ls "$s3_path" >/dev/null 2>&1; then
        log "No existing data in S3, skipping restore"
        update_metadata "restore" "no_data"
        return 0
    fi

    log "Downloading from $s3_path to $SYNC_ROOT"

    # Build exclude arguments
    local exclude_args
    exclude_args=$(build_exclude_args)

    # Restore from S3 (download only, don't delete local files)
    eval aws s3 sync "$s3_path" "$SYNC_ROOT" $exclude_args --no-progress

    # Fix ownership
    chown -R coder:coder "$SYNC_ROOT"

    update_metadata "restore" "success"
    log "Restore completed successfully"
}

# Action: sync
# Incremental sync (changed files only) - used by cron every 5 minutes
do_sync() {
    log "Starting incremental sync to S3..."
    validate_env

    local s3_path
    s3_path=$(get_s3_path)

    if [ ! -d "$SYNC_ROOT" ]; then
        log "Sync root does not exist, skipping sync"
        return 0
    fi

    # Build exclude arguments
    local exclude_args
    exclude_args=$(build_exclude_args)

    log "Syncing $SYNC_ROOT to $s3_path"

    # Incremental sync (upload changes only, don't delete from S3)
    eval aws s3 sync "$SYNC_ROOT" "$s3_path" $exclude_args --no-progress

    update_metadata "sync" "success"
    log "Incremental sync completed"
}

# Action: full-backup
# Full sync with --delete flag - used at container stop (warm stop)
do_full_backup() {
    log "Starting full backup to S3..."
    validate_env

    local s3_path
    s3_path=$(get_s3_path)

    if [ ! -d "$SYNC_ROOT" ]; then
        log "Sync root does not exist, skipping backup"
        return 0
    fi

    # Build exclude arguments
    local exclude_args
    exclude_args=$(build_exclude_args)

    log "Full backup $SYNC_ROOT to $s3_path (with --delete)"

    # Full sync with delete (S3 mirrors local home exactly)
    eval aws s3 sync "$SYNC_ROOT" "$s3_path" $exclude_args --delete --no-progress

    update_metadata "full-backup" "success"
    log "Full backup completed"
}

# Main entry point
main() {
    local action="${1:-}"

    case "$action" in
        restore)
            do_restore
            ;;
        sync)
            do_sync
            ;;
        full-backup)
            do_full_backup
            ;;
        *)
            echo "Usage: $0 <restore|sync|full-backup>"
            echo ""
            echo "Actions:"
            echo "  restore     - Download from S3 to local workspace"
            echo "  sync        - Incremental sync to S3 (changed files only)"
            echo "  full-backup - Full sync to S3 with --delete"
            echo ""
            echo "Environment variables:"
            echo "  S3_SYNC_BUCKET  - S3 bucket name (required)"
            echo "  USER_SUBDOMAIN  - User identifier (required)"
            exit 1
            ;;
    esac
}

main "$@"
