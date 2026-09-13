#!/usr/bin/env bash
# One process per required role. Existing workflows retain their publication gate.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="${3:?Expected diff, lenses directory and work directory}"
. "$DIR/lib.sh"
ensure_slots "$WORK"
python3 "$DIR/prepare_roles.py" --work "$WORK"
pids=()
for tag in codex kiro-fable kiro-sol claude-self; do
  python3 "$DIR/run_role.py" --work "$WORK" --tag "$tag" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  # Aggregation reports missing/failed roles and cannot award coverage for them.
  wait "$pid" || true
done
status=0
python3 "$DIR/role_review.py" aggregate --work "$WORK" || status=$?
# Exit 2 is a recorded coverage failure: let synthesis publish its FAIL report.
[ "$status" -eq 0 ] || [ "$status" -eq 2 ]
