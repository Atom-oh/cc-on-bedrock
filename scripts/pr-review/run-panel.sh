#!/usr/bin/env bash
# One complete report from each of Codex and Claude, executed in parallel.
# Usage: run-panel.sh DIFF LENSES_DIR WORK
set -euo pipefail
DIFF="$(realpath -- "$1")"; LENSES_DIR="$2"; WORK="$3"
[ -n "$LENSES_DIR" ] && [ -n "$WORK" ] || { echo "Empty review path" >&2; exit 1; }
[ ! -L "$WORK" ] || { echo "Review workspace is a symlink" >&2; exit 1; }
mkdir -p "$WORK"
WORK="$(realpath -- "$WORK")"
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"
ensure_slots "$WORK"
SLOT="$WORK/slot"
: > "$WORK/responded.txt"
rm -f "$WORK/coverage-severe.flag" "$WORK/chair-failed.flag"

if ! python3 "$DIR/simple_review.py" prepare "$DIFF" "$LENSES_DIR" "$WORK"; then
  : > "$WORK/coverage-severe.flag"
  exit 0  # Synthesis emits the deterministic BLOCKED report.
fi

T="${PANEL_TIMEOUT:-300}"
RETRIES="${PANEL_RETRIES:-2}"
[[ "$T" =~ ^[1-9][0-9]*$ && "$RETRIES" =~ ^[1-9][0-9]*$ ]] || exit 1
[ "$T" -le 300 ] && [ "$RETRIES" -le 2 ] || { echo "Panel budget exceeds CI limit" >&2; exit 1; }
PROMPT="$(cat "$WORK/panel-prompt.txt")"

run_reviewer() {
  local tag="$1"; shift
  local attempt rc
  for ((attempt=1; attempt<=RETRIES; attempt++)); do
    rc=0
    env -u GH_TOKEN -u GITHUB_TOKEN timeout --kill-after=10s "$T" "$@" \
      < "$WORK/panel-input.txt" > "$SLOT/$tag.raw" 2> "$SLOT/$tag.err" || rc=$?
    printf '%s\n' "$rc" > "$SLOT/$tag.md.rc"
    scrub_secrets < "$SLOT/$tag.raw" > "$SLOT/$tag.md"
    if [ "$rc" -eq 0 ] && python3 "$DIR/simple_review.py" panel "$SLOT/$tag.md" >/dev/null; then
      rm -f "$SLOT/$tag.raw"
      return 0
    fi
    : > "$SLOT/$tag.md"
    echo "[$tag attempt $attempt/$RETRIES] incomplete review (exit=$rc)" >&2
  done
  rm -f "$SLOT/$tag.raw"
  return 1
}

run_reviewer codex codex -c web_search=disabled exec \
  --model "${CODEX_REVIEW_MODEL:-global.openai.gpt-6-astra}" \
  -s read-only --skip-git-repo-check -- "$PROMPT" &
CODEX_PID=$!
run_reviewer claude env ANTHROPIC_MODEL="${CLAUDE_PANEL_MODEL:-global.anthropic.claude-opus-5}" \
  claude -p "$PROMPT" --output-format text --tools "" --strict-mcp-config \
  --setting-sources "" &
CLAUDE_PID=$!
trap 'kill "$CODEX_PID" "$CLAUDE_PID" 2>/dev/null || true' TERM INT
wait "$CODEX_PID" || true
wait "$CLAUDE_PID" || true
trap - TERM INT

for tag in codex claude; do
  record_result "$SLOT/$tag.md" "$tag" "$WORK/responded.txt"
done
if [ "$(wc -l < "$WORK/responded.txt")" -ne 2 ]; then
  : > "$WORK/coverage-severe.flag"
  echo "::error::Both complete independent reviews are required" >&2
fi
echo "Panel responded: $(tr '\n' ' ' < "$WORK/responded.txt")"
