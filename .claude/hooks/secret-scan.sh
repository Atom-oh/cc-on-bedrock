#!/bin/bash
# PreToolUse hook: scan for secrets before writing files
# Blocks commits/writes containing AWS keys, API tokens, passwords

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only scan file-write operations
case "$TOOL_NAME" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip binary/config files
case "$FILE_PATH" in
  *.png|*.jpg|*.ico|*.woff*|*.lock|*.tsbuildinfo) exit 0 ;;
esac

PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'sk-ant-[a-zA-Z0-9]{20,}'
  'ghp_[a-zA-Z0-9]{36}'
  'xoxb-[0-9]+-[a-zA-Z0-9]+'
  'sk-[a-zA-Z0-9]{48}'
)

for pattern in "${PATTERNS[@]}"; do
  if echo "$CONTENT" | grep -qE "$pattern"; then
    # PreToolUse block signal: exit code 2 + reason on stderr
    echo "Secret detected in file content (pattern: ${pattern}). Remove the secret before writing." >&2
    exit 2
  fi
done

exit 0
