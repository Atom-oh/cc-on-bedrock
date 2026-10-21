#!/usr/bin/env bash
# Lens panel: one Codex review per lens, all lenses in parallel.
# Usage: run-panel.sh <diff> <lenses_dir> <workdir>
# Each *.txt in lenses_dir is one self-contained lens prompt (file stem = lens tag,
# e.g. L2..L5). Codex (PANEL_MODEL, default global.openai.gpt-6.1-sol) reviews each
# lens from the diff on stdin; synthesize.sh then has Claude (the chair) review the
# same diff and adjudicate. The diff is a file on stdin, so no TTY hang; every cell
# has a timeout backstop and up to PANEL_RETRIES attempts.
set -uo pipefail

# ROLE_REVIEW=1 selects the retained specialist protocol.
if [ "${ROLE_REVIEW:-0}" = 1 ]; then
  exec bash "$(dirname "$0")/run-specialists.sh" "$@"
fi
DIFF="$(realpath "$1" 2>/dev/null)" \
  || { echo "run-panel.sh: realpath failed to resolve diff path: $1" >&2; exit 1; }
LENSES_DIR="$2"; WORK="$3"
# An empty $WORK would turn ensure_slots' `rm -rf "$1/slot"` into `rm -rf /slot`.
[ -n "$LENSES_DIR" ] || { echo "run-panel.sh: lenses_dir (\$2) must not be empty" >&2; exit 1; }
[ -n "$WORK" ] || { echo "run-panel.sh: workdir (\$3) must not be empty" >&2; exit 1; }
# Check for a symlink before realpath resolves it away.
[ -L "$WORK" ] && { echo "run-panel.sh: \$WORK ($WORK) is a symlink, refusing" >&2; exit 1; }
mkdir -p "$WORK" || { echo "run-panel.sh: failed to create workdir: $WORK" >&2; exit 1; }
WORK="$(realpath "$WORK")" \
  || { echo "run-panel.sh: realpath failed to resolve workdir: $WORK" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/lib.sh"
ensure_slots "$WORK" || exit 1
SLOT="$WORK/slot"; RESP="$WORK/responded.txt"; : > "$RESP"
# A reused workdir on a non-ephemeral runner must not carry over the last run's flags.
rm -f "$WORK"/*.flag; : > "$WORK/degraded-models.txt"
T="${PANEL_TIMEOUT:-300}"
RETRIES="${PANEL_RETRIES:-3}"
PANEL_MODEL="${PANEL_MODEL:-global.openai.gpt-6.1-sol}"

shopt -s nullglob
LENS_FILES=("$LENSES_DIR"/*.txt)
shopt -u nullglob
if [ "${#LENS_FILES[@]}" -eq 0 ]; then
  echo "run-panel.sh: no *.txt lens files found in $LENSES_DIR" >&2
  exit 1
fi

# Codex gets an allowlisted environment: only what its amazon-bedrock-runtime
# provider needs (AWS SDK credential chain + CODEX_* config), never runner tokens
# or other keys present on the runner.
codex_env() {
  local -a keep=(PATH="$PATH" HOME="$HOME" LANG="${LANG:-}" LC_ALL="${LC_ALL:-}" TMPDIR="${TMPDIR:-/tmp}")
  local name
  for name in $(compgen -e); do
    case "$name" in AWS_*|CODEX_*) keep+=("$name=${!name}") ;; esac
  done
  env -i "${keep[@]}" "$@"
}

# Run one cell up to $RETRIES times; an empty slot or a non-zero exit is retried.
#   try_panel <slot> <err> <cmd...>   (stdin=$DIFF, stdout=slot, stderr=err)
try_panel() {
  local slot="$1" err="$2"; shift 2
  local a rc=1
  for a in $(seq 1 "$RETRIES"); do
    "$@" > "$slot" 2>"$err" < "$DIFF"; rc=$?
    [ -s "$slot" ] && [ "$rc" -eq 0 ] && break
    [ "$a" -lt "$RETRIES" ] && echo "[retry $a/$RETRIES] $(basename "$slot" .md)" >&2
  done
  echo "$rc" > "$slot.rc"
}

if ! command -v codex >/dev/null 2>&1; then
  echo "::error::codex CLI not found on runner — no panel coverage" >&2
fi
for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  LENS_PROMPT="$(cat "$lens_file")"
  if command -v codex >/dev/null 2>&1; then
    ( try_panel "$SLOT/codex-$lens.md" "$SLOT/codex-$lens.err" \
        codex_env timeout "$T" codex -c web_search=disabled exec \
          --model "$PANEL_MODEL" -s read-only --skip-git-repo-check "$LENS_PROMPT" ) &
  else
    echo "codex CLI not found on runner" > "$SLOT/codex-$lens.err"
    : > "$SLOT/codex-$lens.md"
  fi
done
wait

for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  record_result "$SLOT/codex-$lens.md" "codex/$lens" "$RESP"
done
echo "Panel responded ($(wc -l < "$RESP") / ${#LENS_FILES[@]} cells, $PANEL_MODEL): $(tr '\n' ' ' < "$RESP")"

# Codex is the only panel vendor, so every lens must be covered: a missing lens has
# no cross-check left and forces VERDICT: FAIL in synthesize.sh (fail-closed).
RESPONDED="$(wc -l < "$RESP" 2>/dev/null)"
if [ "${RESPONDED:-0}" -lt "${#LENS_FILES[@]}" ]; then
  echo "codex" >> "$WORK/degraded-models.txt"
  echo "::error::codex did not complete every lens — forcing VERDICT: FAIL" >&2
  : > "$WORK/coverage-severe.flag"
fi

# Surface why a cell was skipped. Actions logs on a public repo are world-readable, so
# stderr passes the same scrub_secrets() as the cell output.
for e in "$SLOT"/*.err; do
  [ -s "$e" ] || continue
  b="$(basename "$e" .err)"
  [ -s "$SLOT/$b.md" ] && continue
  echo "--- [$b] skipped; stderr (last 25 lines, scrubbed) ---" >&2
  tail -25 "$e" | scrub_secrets >&2
done
