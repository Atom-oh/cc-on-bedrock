#!/usr/bin/env bash
# scripts/pr-review/run-panel.sh 의 Kiro 셀 fail-closed 계약을 핀한다.
# kiro-cli 2.11.1 에서 `--trust-tools=`(빈 값)은 "무툴"이 아니라 무시되는 경고 한 줄로
# 퇴화했다(내장 툴 이름이 fs_read → read 등으로 바뀌며 cwd 안 read 가 기본 신뢰됨). 무툴은
# `tools: []` 에이전트를 `--agent` 로 지정해야만 성립하고(v2 엔진; `--v3` 는 이를 무시함),
# 월간 요청 한도(MONTHLY_REQUEST_COUNT) 소진은 rc=0+빈 stdout 으로 끝나 재시도만 태우므로
# 시그니처 감지가 있어야 원인이 코멘트/로그에 드러난다. 둘 다 조용히 되돌려지는 걸 막는다.
# 정적 검사(bash -n + grep) + kiro-cli/codex 스텁으로 run-panel.sh 를 실제 실행하는 동작
# 검사. 실제 모델 호출은 없다(공유 CI 키 크레딧 소비 없음). 원본: claude-code-usage-dashboard
# 저장소 PR #33 의 tests/structure/test-pr-review-panel.sh — 이 repo 의 chk 스타일로 이식.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PANEL="${ROOT}/scripts/pr-review/run-panel.sh"
SYNTH="${ROOT}/scripts/pr-review/synthesize.sh"
LIB="${ROOT}/scripts/pr-review/lib.sh"
AGENT="${ROOT}/scripts/pr-review/agents/pr-review-notools.json"
RUNBOOK="${ROOT}/docs/runbooks/pr-review-panel.md"
fail=0
ok()   { echo "  ok: $1"; }
bad()  { echo "  FAIL: $1"; fail=1; }
# 주석 줄을 제외한 소스만 검사한다 — 주석은 옛 플래그를 역사적 근거로 인용해도 된다.
PANEL_SRC="$(grep -v '^\s*#' "$PANEL")"
SYNTH_SRC="$(grep -v '^\s*#' "$SYNTH")"
chk()   { if printf '%s\n' "$PANEL_SRC" | grep -qE -- "$1"; then ok "$2"; else bad "$2 (missing in run-panel.sh: $1)"; fi; }
nochk() { if printf '%s\n' "$PANEL_SRC" | grep -qE -- "$1"; then bad "$2 (must NOT contain: $1)"; else ok "$2"; fi; }
schk()  { if printf '%s\n' "$SYNTH_SRC" | grep -qE -- "$1"; then ok "$2"; else bad "$2 (missing in synthesize.sh: $1)"; fi; }
eq()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi; }
has()   { if [ -f "$2" ]; then ok "$1"; else bad "$1 (missing: $2)"; fi; }
grepout()   { if printf '%s\n' "$2" | grep -qE -- "$1"; then ok "$3"; else bad "$3 (expected /$1/ in output)"; fi; }
nogrepout() { if printf '%s\n' "$2" | grep -qE -- "$1"; then bad "$3 (unexpected /$1/ in output)"; else ok "$3"; fi; }

echo "== syntax + agent config =="
bash -n "$PANEL" && ok "run-panel.sh valid bash" || bad "run-panel.sh syntax"
bash -n "$SYNTH" && ok "synthesize.sh valid bash" || bad "synthesize.sh syntax"
has "kiro no-tools agent config present" "$AGENT"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$AGENT" 2>/dev/null \
  && ok "agent config is valid JSON" || bad "agent config is valid JSON"
AGENT_NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$AGENT" 2>/dev/null || true)
eq "agent .name is pr-review-notools" "pr-review-notools" "$AGENT_NAME"
AGENT_TOOLS=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get("tools",["x"])), len(d.get("mcpServers",{"x":1})))' "$AGENT" 2>/dev/null || true)
eq "agent declares tools: [] and no mcpServers" "0 0" "$AGENT_TOOLS"

echo "== run-panel.sh invocation contract =="
if printf '%s' "$PANEL_SRC" | tr '\n' ' ' | grep -qE 'kiro-cli chat .*--agent "\$KIRO_AGENT_NAME"'; then
  ok "run-panel.sh passes --agent \"\$KIRO_AGENT_NAME\" to kiro-cli chat"
else bad "run-panel.sh passes --agent \"\$KIRO_AGENT_NAME\" to kiro-cli chat"; fi
chk 'cp "\$KIRO_AGENT_SRC" "\$CELL_CWD/\.kiro/agents/"' "run-panel.sh copies the agent file into each cell cwd"
nochk '-{2}trust-tools' "run-panel.sh no longer relies on --trust-tools= (ignored by kiro-cli 2.11.1)"
nochk '-{2}mode default' "run-panel.sh no longer passes --mode default (v3-only flag)"
nochk 'kiro-cli -{2}v3|-{2}agent-engine' "run-panel.sh does not use the --v3 engine (ignores tools: [])"
chk 'kiro-cli --version' "run-panel.sh logs the kiro-cli version"

echo "== failure signatures =="
chk 'Monthly request limit reached' "run-panel.sh detects the Kiro monthly quota signature (v2 stderr)"
chk 'MONTHLY_REQUEST_COUNT' "run-panel.sh detects the Kiro monthly quota signature (v3/JSON)"
chk 'kiro-quota\.flag' "run-panel.sh writes kiro-quota.flag for synthesize.sh"
schk 'kiro-quota\.flag' "synthesize.sh renders the Kiro quota banner"
chk 'no agent with name' "run-panel.sh detects the --agent fallback signature"
chk 'kiro-agent-fallback\.flag' "run-panel.sh writes kiro-agent-fallback.flag"
schk 'kiro-agent-fallback\.flag' "synthesize.sh renders the agent-fallback banner"
has "runbook for the panel failure modes exists" "$RUNBOOK"

# ── 동작 테스트: kiro-cli/codex 스텁으로 run-panel.sh 를 실제 실행 ─────────────────
if command -v timeout >/dev/null 2>&1; then
  T_STUB="$(mktemp -d)"
  trap 'rm -rf "$T_STUB"' EXIT
  mkdir -p "$T_STUB/bin" "$T_STUB/lenses"
  echo "lens" > "$T_STUB/lenses/L2.txt"
  printf 'diff --git a/x b/x\n+x\n' > "$T_STUB/diff.txt"
  run_panel() {  # 스텁 PATH 로 run-panel.sh 실행, stdout+stderr 를 반환
    PATH="$T_STUB/bin:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=3 \
      bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true
  }
  count_flags() { find "$T_STUB/work" -maxdepth 1 -name '*.flag' | wc -l | tr -d ' '; }
  # 모든 kiro-cli 스텁은 `--version` 에 답한다(run-panel.sh 첫 줄 로그).
  kiro_stub() {  # $1 = 본문(bash)
    { printf '#!/bin/bash\n[ "${1:-}" = "--version" ] && { echo "kiro-cli test"; exit 0; }\n'; printf '%s\n' "$1"; } > "$T_STUB/bin/kiro-cli"
    chmod +x "$T_STUB/bin/kiro-cli"
  }
  codex_stub() { printf '#!/bin/bash\n%s\n' "$1" > "$T_STUB/bin/codex"; chmod +x "$T_STUB/bin/codex"; }

  echo "== stub: quota exhaustion (v2 — rc=0, empty stdout, stderr message) =="
  kiro_stub $'printf \'Monthly request limit reached\\nThe limits reset on 10/01.\\n\' >&2\nexit 0'
  codex_stub 'cat > /dev/null; echo "no findings"'
  OUT="$(run_panel)"
  grepout '^run-panel\.sh: kiro-cli test' "$OUT" "kiro-cli version is logged"
  nogrepout '\[retry ' "$OUT" "quota exhaustion is not retried"
  grepout '\[quota\] kiro-' "$OUT" "quota exhaustion logs [quota] per cell"
  grepout '::error::Kiro monthly request quota exhausted.*reset on 10/01' "$OUT" "quota exhaustion is reported as ::error:: with the reset date"
  has "quota exhaustion leaves kiro-quota.flag" "$T_STUB/work/kiro-quota.flag"
  has "quota exhaustion still forces coverage-severe (fail-closed kept)" "$T_STUB/work/coverage-severe.flag"
  [ -f "$T_STUB/work/kiro-agent-fallback.flag" ] && bad "quota run must not raise the agent-fallback flag" || ok "quota run does not raise the agent-fallback flag"

  echo "== stub: quota exhaustion (v3 shape — rc=1, message on stdout, JSON on stderr) =="
  kiro_stub $'echo "You\'ve reached your monthly usage limit."\necho \'[ERROR] [KRS] HTTP 400 body={"__type":"...ServiceQuotaExceededException","reason":"MONTHLY_REQUEST_COUNT"}\' >&2\nexit 1'
  OUT="$(run_panel)"
  nogrepout '\[retry ' "$OUT" "v3-style quota error is not retried"
  grepout '::error::Kiro monthly request quota exhausted' "$OUT" "v3-style quota error is reported"
  KIRO_SLOT_BYTES="$(cat "$T_STUB"/work/slot/kiro-*.md 2>/dev/null | wc -c | tr -d ' ')"
  eq "v3-style quota stdout message is not counted as a response" "0" "$KIRO_SLOT_BYTES"

  echo "== stub: --agent fallback (rc=0 + response, stderr fallback line) =="
  kiro_stub $'echo "Error: no agent with name pr-review-notools found. Falling back to user specified default" >&2\necho "> no findings"\nexit 0'
  OUT="$(run_panel)"
  grepout '\[agent-fallback\] kiro-' "$OUT" "agent fallback logs [agent-fallback] per cell"
  grepout '::error::kiro-cli ignored --agent pr-review-notools' "$OUT" "agent fallback is reported as ::error::"
  nogrepout 'Panel responded.*kiro-' "$OUT" "agent-fallback responses are not counted"
  has "agent fallback leaves kiro-agent-fallback.flag" "$T_STUB/work/kiro-agent-fallback.flag"
  has "agent fallback forces coverage-severe" "$T_STUB/work/coverage-severe.flag"
  [ -f "$T_STUB/work/kiro-quota.flag" ] && bad "fallback run must not raise the quota flag" || ok "fallback run does not raise the quota flag"

  echo "== stub: healthy run =="
  kiro_stub 'echo "> no findings"'
  OUT="$(run_panel)"
  grepout 'Panel responded \(3 / 3 cells\)' "$OUT" "healthy kiro cells are counted"
  eq "healthy run leaves no flags (stale flags from the previous run are reset)" "0" "$(count_flags)"
  AGENT_COPIES="$(find "$T_STUB/work/kiro-cwd" -path '*/.kiro/agents/pr-review-notools.json' | wc -l | tr -d ' ')"
  eq "agent file is copied into every kiro cell cwd" "2" "$AGENT_COPIES"

  echo "== stub: Codex stderr quoting Kiro signatures is not misclassified =="
  # Codex 는 입력 diff 를 stderr 에도 출력한다 — Kiro 오류 문구를 인용하는 정상 리뷰(이 파일을
  # 고치는 PR 이 그 예)가 Kiro 폴백/한도로 폐기되면 안 된다.
  codex_stub 'cat >&2; echo "no findings"'
  printf 'diff --git a/x b/x\n+Monthly request limit reached\n+no agent with name pr-review-notools found\n' > "$T_STUB/diff.txt"
  OUT="$(run_panel)"
  grepout 'Panel responded \(3 / 3 cells\)' "$OUT" "Codex quoting Kiro errors remains a successful response"
  eq "quoted Kiro errors in Codex stderr leave no flags" "0" "$(count_flags)"

  echo "== stub: Codex transient failure still retries =="
  codex_stub $'cat >/dev/null\nprintf \'attempt\\n\' >> "$0.attempts"\nif [ "$(wc -l < "$0.attempts")" -eq 1 ]; then\n  echo "Reviewed code quotes: Monthly request limit reached" >&2\n  exit 1\nfi\necho "no findings"'
  OUT="$(run_panel)"
  CODEX_ATTEMPTS="$(wc -l < "$T_STUB/bin/codex.attempts" | tr -d ' ')"
  eq "Codex retries its own transient failure despite a quoted Kiro quota" "2" "$CODEX_ATTEMPTS"
  grepout 'Panel responded \(3 / 3 cells\)' "$OUT" "Codex retry can restore full coverage"
  eq "a recovered Codex retry leaves no Kiro failure flags" "0" "$(count_flags)"

  echo "== fail-fast: invalid agent configuration never reaches a model =="
  codex_stub 'cat >/dev/null; echo "no findings"'
  kiro_stub 'touch "$0.chat-invoked"; echo "no findings"'
  mkdir -p "$T_STUB/fixture/agents"
  cp "$PANEL" "$T_STUB/fixture/run-panel.sh"; cp "$LIB" "$T_STUB/fixture/lib.sh"
  echo '{"name":"pr-review-notools","tools":[],"tools":["read"],"allowedTools":[],"mcpServers":{},"resources":[],"useLegacyMcpJson":false}' \
    > "$T_STUB/fixture/agents/pr-review-notools.json"
  PANEL_RC=0
  PATH="$T_STUB/bin:$PATH" bash "$T_STUB/fixture/run-panel.sh" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" >/dev/null 2>&1 || PANEL_RC=$?
  eq "duplicate JSON keys are rejected before startup" "1" "$PANEL_RC"
  echo '{"name":"other-agent","tools":[],"allowedTools":[],"mcpServers":{},"resources":[],"useLegacyMcpJson":false}' \
    > "$T_STUB/fixture/agents/pr-review-notools.json"
  PANEL_RC=0
  PATH="$T_STUB/bin:$PATH" bash "$T_STUB/fixture/run-panel.sh" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" >/dev/null 2>&1 || PANEL_RC=$?
  eq "agent name mismatch is rejected before startup" "1" "$PANEL_RC"
  echo '{"name":"pr-review-notools","tools":["read"],"allowedTools":[],"mcpServers":{},"resources":[],"useLegacyMcpJson":false}' \
    > "$T_STUB/fixture/agents/pr-review-notools.json"
  PANEL_RC=0
  PATH="$T_STUB/bin:$PATH" bash "$T_STUB/fixture/run-panel.sh" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" >/dev/null 2>&1 || PANEL_RC=$?
  eq "non-empty tools list is rejected before startup" "1" "$PANEL_RC"
  rm -f "$T_STUB/fixture/agents/pr-review-notools.json"
  PANEL_RC=0
  PATH="$T_STUB/bin:$PATH" bash "$T_STUB/fixture/run-panel.sh" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" >/dev/null 2>&1 || PANEL_RC=$?
  eq "missing agent file is rejected before startup" "1" "$PANEL_RC"
  CHAT_CALLS="$(find "$T_STUB/bin" -maxdepth 1 -name 'kiro-cli.chat-invoked' | wc -l | tr -d ' ')"
  eq "invalid agent configuration never reaches a model" "0" "$CHAT_CALLS"

  echo "== fail-fast: failed agent copy aborts =="
  printf '#!/bin/bash\nexit 1\n' > "$T_STUB/bin/cp"; chmod +x "$T_STUB/bin/cp"
  PANEL_RC=0
  PATH="$T_STUB/bin:$PATH" bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" >/dev/null 2>&1 || PANEL_RC=$?
  eq "failed agent copy aborts run-panel.sh" "1" "$PANEL_RC"
  CHAT_CALLS="$(find "$T_STUB/bin" -maxdepth 1 -name 'kiro-cli.chat-invoked' | wc -l | tr -d ' ')"
  eq "failed agent copy never reaches a model" "0" "$CHAT_CALLS"
  rm -f "$T_STUB/bin/cp"
else
  echo "  skip: run-panel.sh stub behaviour (timeout(1) not available)"
fi

[ "${fail}" -eq 0 ] && echo "ALL pr-review panel TESTS PASSED" || echo "pr-review panel TESTS FAILED"
exit "${fail}"
