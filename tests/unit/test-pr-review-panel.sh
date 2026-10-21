#!/usr/bin/env bash
# Pins the simplified AI review contract: scripts/pr-review/run-panel.sh runs one Codex
# (gpt-6.1-sol) cell per lens and fails closed when any lens is missing; synthesize.sh
# uses Claude Opus 5.5 as the tool-less chair and forces VERDICT: FAIL on incomplete
# coverage. Static checks plus stubbed codex/claude runs; no real model calls.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PANEL="${ROOT}/scripts/pr-review/run-panel.sh"
SYNTH="${ROOT}/scripts/pr-review/synthesize.sh"
fail=0
ok()   { echo "  ok: $1"; }
bad()  { echo "  FAIL: $1"; fail=1; }
# Check source lines only; comments may cite old flags as history.
PANEL_SRC="$(grep -v '^\s*#' "$PANEL")"
SYNTH_SRC="$(grep -v '^\s*#' "$SYNTH")"
chk()   { if printf '%s\n' "$PANEL_SRC" | grep -qE -- "$1"; then ok "$2"; else bad "$2 (missing in run-panel.sh: $1)"; fi; }
nochk() { if printf '%s\n' "$PANEL_SRC" | grep -qE -- "$1"; then bad "$2 (must NOT contain: $1)"; else ok "$2"; fi; }
schk()  { if printf '%s\n' "$SYNTH_SRC" | grep -qE -- "$1"; then ok "$2"; else bad "$2 (missing in synthesize.sh: $1)"; fi; }
eq()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi; }
grepout()   { if printf '%s\n' "$2" | grep -qE -- "$1"; then ok "$3"; else bad "$3 (expected /$1/ in output)"; fi; }

echo "== syntax + invocation contract =="
bash -n "$PANEL" && ok "run-panel.sh valid bash" || bad "run-panel.sh syntax"
bash -n "$SYNTH" && ok "synthesize.sh valid bash" || bad "synthesize.sh syntax"
chk 'PANEL_MODEL:-global\.openai\.gpt-6\.1-sol' "panel defaults to Codex gpt-6.1-sol"
chk 'codex -c web_search=disabled exec' "Codex runs with web search disabled"
chk 'codex_env timeout' "Codex runs under the allowlisted env"
nochk 'kiro-cli' "panel no longer invokes Kiro"
schk 'CHAIR_PRIMARY_MODEL:-global\.anthropic\.claude-opus-5-5' "chair defaults to Claude Opus 5.5"
schk '--tools "" --strict-mcp-config --setting-sources ""' "chair runs tool-less with no setting sources"

if command -v timeout >/dev/null 2>&1; then
  T_STUB="$(mktemp -d)"
  trap 'rm -rf "$T_STUB"' EXIT
  mkdir -p "$T_STUB/bin" "$T_STUB/lenses"
  for l in L2 L3 L4 L5; do echo "lens $l" > "$T_STUB/lenses/$l.txt"; done
  printf 'diff --git a/x b/x\n+x\n' > "$T_STUB/diff.txt"
  codex_stub() { printf '#!/bin/bash\n%s\n' "$1" > "$T_STUB/bin/codex"; chmod +x "$T_STUB/bin/codex"; }
  run_panel() {
    PATH="$T_STUB/bin:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=2 GH_TOKEN=gh-secret KIRO_API_KEY=kiro-secret \
      AWS_REGION=ap-northeast-2 bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true
  }

  echo "== stub: healthy Codex covers every lens =="
  codex_stub 'cat >/dev/null; env > "$0.env.$$"; printf "%s\n" "$*" > "$0.args.$$"; echo "no findings"'
  OUT="$(run_panel)"
  grepout 'Panel responded \(4 / 4 cells, global\.openai\.gpt-6\.1-sol\)' "$OUT" "all four lens cells are counted"
  [ -f "$T_STUB/work/coverage-severe.flag" ] && bad "healthy run must not raise coverage-severe" || ok "healthy run leaves no coverage-severe flag"
  ENV_DUMP="$(cat "$T_STUB"/bin/codex.env.* 2>/dev/null)"
  printf '%s\n' "$ENV_DUMP" | grep -qE '^(GH_TOKEN|KIRO_API_KEY)=' && bad "Codex env must not carry GH_TOKEN/KIRO_API_KEY" || ok "Codex env drops GH_TOKEN and KIRO_API_KEY"
  printf '%s\n' "$ENV_DUMP" | grep -q '^AWS_REGION=ap-northeast-2$' && ok "Codex env keeps AWS_* for the Bedrock provider" || bad "Codex env keeps AWS_* for the Bedrock provider"
  grep -q -- '--model global.openai.gpt-6.1-sol' "$T_STUB"/bin/codex.args.* 2>/dev/null && ok "Codex is called with gpt-6.1-sol" || bad "Codex is called with gpt-6.1-sol"
  rm -f "$T_STUB"/bin/codex.env.* "$T_STUB"/bin/codex.args.*

  echo "== stub: a missing lens fails closed =="
  codex_stub 'cat >/dev/null; case "$*" in *"lens L3"*) exit 1 ;; esac; echo "no findings"'
  OUT="$(run_panel)"
  grepout 'Panel responded \(3 / 4 cells' "$OUT" "the failed lens is not counted"
  [ -f "$T_STUB/work/coverage-severe.flag" ] && ok "missing lens raises coverage-severe" || bad "missing lens raises coverage-severe"

  echo "== stub: chair verdict is overridden by incomplete coverage =="
  printf '#!/bin/bash\ncat >/dev/null\necho "Looks fine."\necho "VERDICT: PASS"\n' > "$T_STUB/bin/claude"; chmod +x "$T_STUB/bin/claude"
  PATH="$T_STUB/bin:$PATH" bash "$SYNTH" "$T_STUB/diff.txt" "$T_STUB/work" 1 "title" "$T_STUB/review.md" >/dev/null 2>&1 || true
  eq "coverage-severe forces the final VERDICT: FAIL" "VERDICT: FAIL" "$(awk 'NF{last=$0} END{print last}' "$T_STUB/review.md")"

  echo "== stub: complete coverage keeps the chair verdict =="
  codex_stub 'cat >/dev/null; echo "no findings"'
  run_panel >/dev/null
  PATH="$T_STUB/bin:$PATH" bash "$SYNTH" "$T_STUB/diff.txt" "$T_STUB/work" 1 "title" "$T_STUB/review.md" >/dev/null 2>&1 || true
  eq "a valid chair PASS stands with full coverage" "VERDICT: PASS" "$(awk 'NF{last=$0} END{print last}' "$T_STUB/review.md")"
else
  echo "  skip: stub behaviour (timeout(1) not available)"
fi

[ "${fail}" -eq 0 ] && echo "ALL pr-review panel TESTS PASSED" || echo "pr-review panel TESTS FAILED"
exit "${fail}"
