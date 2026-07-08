#!/usr/bin/env bash
# 패널 병렬 fan-out. 인자: <diff> <prompt> <workdir>
# codex 는 diff 를 stdin(`< "$DIFF"`)으로 받고, kiro-cli 는 chat ARG 로 받는다(아래 KIRO_MSG).
# timeout 백스톱 + 비대화형 플래그로 멈춤 방지. 슬롯이 비면 최대 PANEL_RETRIES 회 재시도
# (gpt-5.5/bedrock-mantle 등 transient 흡수). 매 시도마다 $DIFF 를 다시 연다.
set -uo pipefail
DIFF="$1"; PROMPT_FILE="$2"; WORK="$3"
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/lib.sh"
ensure_slots "$WORK"
SLOT="$WORK/slot"; RESP="$WORK/responded.txt"; : > "$RESP"
T="${PANEL_TIMEOUT:-300}"
RETRIES="${PANEL_RETRIES:-3}"
PROMPT="$(cat "$PROMPT_FILE")"
KIRO_MODELS=("claude-opus-4.8:kiro-opus" "gpt-5.5:kiro-gpt" "glm-5:kiro-glm")

# 한 패널을 최대 $RETRIES 회 실행 — 슬롯이 비면 재시도(transient). 백그라운드로 호출.
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

# Codex (Bedrock, config.toml). --skip-git-repo-check 필수. AWS_REGION 강제: gpt-5.5
# (bedrock-mantle)는 In-Region(us-east-1) 만 지원 — 잡 region 무관하게 고정.
if command -v codex >/dev/null 2>&1; then
  ( try_panel "$SLOT/codex.md" "$SLOT/codex.err" \
      env AWS_REGION="${CODEX_AWS_REGION:-us-east-1}" AWS_DEFAULT_REGION="${CODEX_AWS_REGION:-us-east-1}" \
      timeout "$T" codex exec -s read-only --skip-git-repo-check "$PROMPT" ) &
else echo "[skip] codex (binary absent)" >&2; : > "$SLOT/codex.md"; fi

# Kiro x3 — model:tag 를 한 배열에서 파생(호출/집계 동기화).
# kiro-cli `chat` 는 메시지를 ARG 로 받는다 — codex 와 달리 stdin 을 읽지 않는다. prompt +
# diff 를 합쳐 chat ARG 로 전달한다(과거 PR 리뷰에서 kiro-opus/kimi/glm 전부 리뷰 불성립의
# 원인이었던 stdin-only 전달 버그의 수정). `--trust-tools=read,grep` 는 무효한 플래그가
# 아니라 **실제로 파일 read 를 그랜트한다** — 직접 재현 확인(`kiro-cli chat "Use your read
# tool to read /etc/hostname..." --trust-tools=read,grep` 가 실제로 파일을 읽어냄). diff 는
# untrusted PR 콘텐츠이므로 이 그랜트는 diff-injection 이 절대경로 read 를 유도할 수 있는
# CRITICAL exfiltration 경로다(claude-code-usage-dashboard PR #4 리뷰에서 다른 repo의 동일
# 계열 버그로 발견 — fs_read 를 vector로 썼을 뿐 위협모델은 동일). `--trust-tools=` 로 툴을
# 아예 안 주면 이 경로가 구조적으로 막힌다. diff 는 이미 argv 에 직접 embed 되므로(위) 이
# 수정으로 기능 변화는 없다. `--trust-tools=`(빈 값)이 "무툴"임은 라이브 재현만이 아니라
# kiro-cli 자신의 공식 문서(`kiro-cli chat --help`): "trust no tools: '--trust-tools='" —
# 그대로 인용되는 예시 문구다(버전: `kiro-cli 2.11.1`). 향후 kiro-cli 가 이 시맨틱을 바꾸면
# 이 fail-closed 가정도 재검증 필요.
KIRO_MSG="$(printf '%s\n\n=== DIFF UNDER REVIEW (review this) ===\n%s\n' "$PROMPT" "$(cat "$DIFF")")"
for entry in "${KIRO_MODELS[@]}"; do
  m="${entry%%:*}"; tag="${entry##*:}"
  if command -v kiro-cli >/dev/null 2>&1; then
    ( try_panel "$SLOT/$tag.md" "$SLOT/$tag.err" \
        timeout "$T" kiro-cli --v3 chat "$KIRO_MSG" --model "$m" \
        --no-interactive --trust-tools= --wrap never ) &
  else echo "[skip] $tag (binary absent)" >&2; : > "$SLOT/$tag.md"; fi
done

# NOTE: Antigravity(agy) 는 제거됨 — OAuth 인터랙티브 로그인 전용(API 키 인증 모드 없음)
# 이라 헤드리스 CI 에서 인증 불가. 패널 = Codex + Kiro x3 → Claude 의장.
wait

# 결과 집계 (KIRO_MODELS 와 동일 소스에서 tag 파생 → 하드코딩 불일치 방지)
record_result "$SLOT/codex.md" "codex" "$RESP"
for entry in "${KIRO_MODELS[@]}"; do
  tag="${entry##*:}"; record_result "$SLOT/$tag.md" "$tag" "$RESP"
done
echo "Panel responded: $(tr '\n' ' ' < "$RESP")"

# skip 원인 노출: 빈 슬롯인데 stderr 가 있으면 stderr 의 끝(실제 에러)을 로그에 찍는다.
for e in "$SLOT"/*.err; do
  [ -s "$e" ] || continue
  b="$(basename "$e" .err)"
  [ -s "$SLOT/$b.md" ] && continue   # 응답 성공이면 건너뜀
  echo "--- [$b] skipped; stderr (last 25 lines) ---" >&2
  tail -25 "$e" >&2
done
