#!/usr/bin/env bash
# Offline regression checks: no real provider or AWS calls.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
python3 -m unittest discover -s scripts/pr-review -p 'test_simple_review.py' -v
bash -n scripts/pr-review/run-panel.sh scripts/pr-review/synthesize.sh scripts/pr-review/lib.sh
