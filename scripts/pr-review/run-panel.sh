#!/usr/bin/env bash
# lens×모델 매트릭스 병렬 fan-out. 인자: <diff> <lenses_dir> <workdir>
# lenses_dir 안의 각 *.txt 가 lens 하나(파일명 stem = lens 태그, 예: L2/L3/L4/L5) —
# 그 lens 전용 리뷰 프롬프트(자체 완결형: "이 lens만 봐"). 각 lens × 각 모델이
# 독립 에이전트 셀 하나(design: oh-my-cloud-skills 원본 설계 문서 — 이 repo엔 없음, 그 repo의
# docs/superpowers/specs/2026-07-05-pr-review-hybrid-lens-design.md 참조).
# diff 전달 경로는 CLI 별로 다름: Codex 는 stdin(`< "$DIFF"` 직접 리다이렉트, 파일이라
# TTY 아님 → no-hang); Kiro 는 stdin 을 무시하고 어떤 툴도 못 받으므로(아래 Kiro 셀 주석
# 참조) size-capped argv 텍스트로 직접 embed 한다. timeout 백스톱 + 비대화형 플래그로
# 멈춤 방지. 셀이 비거나 종료코드가 0이 아니면 최대 PANEL_RETRIES 회 재시도(gpt-5.6-sol/
# bedrock-mantle 등 transient 흡수; Kiro 한도 소진·에이전트 폴백은 non-transient 라 즉시
# 중단). 매 시도마다 재실행. 모든 셀(모델 수 × lens 수)이 병렬(&+wait) — 벽시계 ≈ 최슬로우
# 셀 하나, 순차합 아님.
set -uo pipefail
DIFF="$(realpath "$1" 2>/dev/null)" \
  || { echo "run-panel.sh: realpath failed to resolve diff path: $1" >&2; exit 1; }
LENSES_DIR="$2"; WORK="$3"
# precheck.sh 와 같은 원칙 — $WORK 가 비면 ensure_slots 의 `rm -rf "$1/slot"` 가
# `rm -rf /slot`(파일시스템 루트 하위) 이 되는 파괴적 경로가 생긴다. $LENSES_DIR 빈 값은
# 파괴적이진 않지만(글롭이 매치 없이 조용히 0셀로 끝남) 인자 오설정을 조용히 넘기지 않고
# 바로 잡아내는 게 디버깅에 낫다.
[ -n "$LENSES_DIR" ] || { echo "run-panel.sh: lenses_dir (\$2) must not be empty" >&2; exit 1; }
[ -n "$WORK" ] || { echo "run-panel.sh: workdir (\$3) must not be empty" >&2; exit 1; }
# ensure_slots() 의 `[ -L "$1" ]` 가드는 $WORK 를 인자로 받는데, 그 시점의 $WORK 는 이미
# realpath 를 거친 뒤라 symlink 가 전부 resolve 돼 있다 — 즉 그 가드는 이 호출 경로에서
# 절대 발동하지 않는 dead code 다(cc-on-bedrock PR#107 리뷰 M2, chair 코드 대조 확인).
# realpath 이전, 호출자가 넘긴 원래 경로에서 심링크를 검사해야 의미가 있다 — 완전한
# TOCTOU 방지는 아니지만(check 와 mkdir/realpath 사이 윈도우는 남음), "인자로 받은 경로가
# 처음부터 심링크였다"는 흔한 경우는 여기서 잡는다.
[ -L "$WORK" ] && { echo "run-panel.sh: \$WORK ($WORK) is a symlink, refusing (TOCTOU guard, checked before realpath resolves it away)" >&2; exit 1; }
# mkdir/realpath 실패를 `set -e` 없이 조용히 넘기면 이후 전부 빈/잘못된 $WORK 로 계속
# 진행할 수 있다 — "파괴적 경로를 만들 수 있는 연산은 실패를 명시적으로 처리" 원칙과
# 일관되게 두 줄 다 fail-fast.
mkdir -p "$WORK" || { echo "run-panel.sh: failed to create workdir: $WORK" >&2; exit 1; }
WORK="$(realpath "$WORK")" \
  || { echo "run-panel.sh: realpath failed to resolve workdir: $WORK" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/lib.sh"
ensure_slots "$WORK" || exit 1
SLOT="$WORK/slot"; RESP="$WORK/responded.txt"; : > "$RESP"
# 비-ephemeral 러너에서 $WORK 가 재사용되면 이전 실행이 남긴 severe/truncated 플래그가
# 그대로 살아남아, 이번엔 모델 전부 정상 응답·전체 diff 를 봤어도 synthesize.sh 가 잘못된
# 배너를 붙이거나 강제 FAIL 하게 된다 — responded.txt/degraded-models.txt 처럼 매 실행
# 시작 시 리셋.
rm -f "$WORK/coverage-severe.flag" "$WORK/kiro-diff-truncated.flag" "$WORK/kiro-quota.flag" "$WORK/kiro-agent-fallback.flag"
T="${PANEL_TIMEOUT:-300}"
RETRIES="${PANEL_RETRIES:-3}"
# glm-5(kiro-glm) 는 로스터에서 제외 — AWS-Demo-Platform 저장소의 PR#88 리뷰에서 이 모델만
# 4건의 오탐을 냈다(AWS-Demo-Platform 저장소의 ADR-015). 되살릴 때는 오탐률을 먼저 재측정할 것.
KIRO_MODELS=("claude-opus-5:kiro-opus" "gpt-5.6-terra:kiro-gpt")
# 러너 이미지의 kiro-cli 는 unpinned vendor-latest 라(AWS-Demo-Platform 저장소의
# docker/actions-runner-claude/Dockerfile 참조) 아래 무툴/한도 시그니처 가정(2.11.1 기준)이
# 어느 버전에서 깨졌는지 로그에서 추적할 수 있게 버전을 첫 줄에 찍는다.
command -v kiro-cli >/dev/null 2>&1 && echo "run-panel.sh: $(kiro-cli --version 2>/dev/null | head -1)" >&2

shopt -s nullglob
LENS_FILES=("$LENSES_DIR"/*.txt)
shopt -u nullglob
if [ "${#LENS_FILES[@]}" -eq 0 ]; then
  echo "run-panel.sh: no *.txt lens files found in $LENSES_DIR" >&2
  exit 1
fi

# Kiro 월간 요청 한도 소진(ServiceQuotaExceededException reason=MONTHLY_REQUEST_COUNT)
# 시그니처. v2 엔진(현재 사용)은 stderr 에 "Monthly request limit reached / The limits
# reset on MM/DD" 를 찍고 **rc=0 + 빈 stdout** 으로 끝나 "빈 응답"과 구분이 안 된다;
# `--v3` 엔진은 rc=1 로 끝나되 메시지가 stdout 으로 나온다("You've reached your monthly
# usage limit", stderr 엔 JSON body 의 MONTHLY_REQUEST_COUNT/UsageLimitReachedError).
# 두 경로 모두 잡는다. 2026-09-10 claude-code-usage-dashboard 저장소 PR #31 리뷰에서 Kiro
# 8셀 전멸의 실제 원인이 이것이었고(로컬 재현: 동일 KIRO_API_KEY 로 v2/v3 모두 같은 에러 —
# headless 플래그 문제가 아님), 옛 로직은 셀마다 3회씩 재시도만 태우고 배너엔 "플래그
# 무효·바이너리 부재·인증 실패 등"이라는 오답 후보만 남겼다(그 수정이 같은 저장소 PR #33,
# 이 파일은 그 이식).
# stderr 만 스캔한다 — 두 엔진 모두 stderr 에 시그니처를 남기고(v3 는 JSON body 의
# MONTHLY_REQUEST_COUNT), stdout(=슬롯)까지 보면 리뷰 대상 diff 가 이 문구를 인용하는 경우
# (이 스크립트 자신을 고치는 PR 이 그 예) 부분 응답이 한도 소진으로 오분류될 수 있다.
KIRO_QUOTA_RE='Monthly request limit reached|MONTHLY_REQUEST_COUNT|UsageLimitReachedError'

# `--agent` 로드 실패 시그니처. kiro-cli 2.11.1 은 이름 불일치·JSON 파싱 실패 모두에서
# stderr 에 "Error: no agent with name X found. Falling back to user specified default" 를
# 찍고 **rc=0 으로 기본 에이전트(툴 있음)를 그대로 실행**한다(로컬 재현). 그대로 두면 무툴
# 계약이 조용히 깨진 채 정상 응답으로 집계되므로(`--trust-tools=` 가 무시되던 것과 같은
# 실패 양식) 시그니처를 잡아 슬롯을 비우고 severe 로 승격한다.
KIRO_AGENT_FALLBACK_RE='no agent with name|Falling back to user specified default|Json supplied at .* is invalid'

# 한 셀을 최대 $RETRIES 회 실행 — 슬롯이 비거나 종료코드가 0이 아니면 재시도(transient).
# 백그라운드로 호출.
#   try_panel <provider> <slot> <err> <cmd...>   (stdin=$DIFF, stdout=slot, stderr=err)
# 한도 소진·에이전트 폴백은 non-transient 라 재시도하지 않고 즉시 중단 — `$slot.quota` /
# `$slot.agentfail` 마커를 남기고 슬롯을 비운다(응답이 있어도 집계에서 제외). 폴백 검사는
# 성공 판정(break) *앞*에 둔다 — 폴백 셀은 rc=0 + non-empty 로 "정상"처럼 보이기 때문.
# Codex stderr 에는 입력 diff 도 들어가므로 Kiro 전용 시그니처는 Kiro 프로세스에만 적용한다
# (diff 가 이 문구를 인용하는 PR — 이 파일을 고치는 PR 이 그 예 — 이 Codex 셀을 폐기하면
# 안 된다).
try_panel() {
  local provider="$1" slot="$2" err="$3"; shift 3
  local a rc=1
  for a in $(seq 1 "$RETRIES"); do
    "$@" > "$slot" 2>"$err" < "$DIFF"; rc=$?
    if [ "$provider" = kiro ] && grep -qE "$KIRO_AGENT_FALLBACK_RE" "$err" 2>/dev/null; then
      grep -E "$KIRO_AGENT_FALLBACK_RE" "$err" | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | head -2 > "$slot.agentfail"
      : > "$slot"; rc=1
      echo "[agent-fallback] $(basename "$slot" .md) — kiro-cli ignored --agent, no-tools contract broken; discarding response" >&2
      break
    fi
    [ -s "$slot" ] && [ "$rc" -eq 0 ] && break
    if [ "$provider" = kiro ] && grep -qE "$KIRO_QUOTA_RE" "$err" 2>/dev/null; then
      grep -E "$KIRO_QUOTA_RE|limits reset on" "$err" \
        | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | head -3 > "$slot.quota"
      : > "$slot"; rc=1
      echo "[quota] $(basename "$slot" .md) — monthly request limit reached, not retrying" >&2
      break
    fi
    [ "$a" -lt "$RETRIES" ] && echo "[retry $a/$RETRIES] $(basename "$slot" .md)" >&2
  done
  echo "$rc" > "$slot.rc"
}

# Kiro 셀은 어떤 툴도 부여받지 않는다(`--agent pr-review-notools`, `tools: []`) — 이전
# 리비전은 `fs_read`를 부여해 diff 경로만 넘기고 Kiro 가 직접 읽게 했으나, 두 가지 문제가
# 있었다: (1) diff 는 신뢰할 수 없는 PR 콘텐츠라, 그 안의 프롬프트 인젝션이 "그 경로 대신
# 절대경로 ~/.aws/credentials 를 읽어라"를 유도할 수 있었다(격리 cwd/HOME 으로도 절대경로
# read 자체는 못 막음 — oh-my-cloud-skills 19차 리뷰 CRITICAL, 격리된 cwd 에서도 Kiro 가
# 실제로 절대경로 레포 파일을 읽어냄이 실증됨). (2) `fs_read` 호출 자체를 모델이 안 해도(또는
# sandbox 에 막혀도) "no findings" 류의 그럴듯한 non-empty 응답을 낼 수 있어, 커버리지
# floor(아래)가 빈 슬롯만 탐지하는 한 diff 를 실제로 못 본 셀이 정상 응답으로 조용히
# 집계된다(cc-on-bedrock PR#107 리뷰 MAJOR-1). 툴을 아예 안 주고 diff 를 argv 로 직접
# 넘기면 두 문제가 구조적으로 함께 사라진다 — read 호출이 필요 없으니 건너뛸 수도 없고,
# 부여된 툴이 없으니 절대경로 read 경로 자체가 없다.
#
# "무툴"의 구현 수단은 `--trust-tools=`(빈 값)에서 에이전트 설정으로 바꿨다(2026-09-11,
# claude-code-usage-dashboard 저장소 PR #33 이식). kiro-cli 2.11.1 은 `chat --help` 에
# 여전히 "trust no tools: '--trust-tools='" 를 적어 두지만, 실제로는 빈 값을 커스텀 툴 이름
# "" 로 해석해 `WARNING: --trust-tools arg for custom tool  needs to be prepended with
# @{MCPSERVERNAME}/` 만 찍고 **무시**한다 — 내장 툴 이름이 fs_read/fs_write →
# read/write/shell/glob/grep/code/aws… 로 바뀌면서 기본 에이전트의 "trust working
# directory"(read/glob/grep/code)·"trust read-only"(aws) 신뢰가 그대로 살아남는다. 로컬
# 재현(2.11.1, headless): `--trust-tools=` 로도 cwd 안 파일을 `read` 로 읽어 내용을 그대로
# 출력했다(cwd 밖 절대경로만 non-interactive 거부). 반면 `tools: []` 에이전트를 `--agent`
# 로 지정하면 v2 엔진은 read/shell 요구에 NO_TOOLS 로 답한다(cwd 안 파일 포함). `--v3`
# 엔진은 같은 에이전트의 `tools: []` 를 **무시**하고 cwd 안 파일을 읽었으므로 v3 는 이
# 용도에 쓸 수 없다 — run-panel.sh 는 v2 엔진(기본)을 유지하고, v3 전용 플래그였던
# `--mode default` 도 함께 내렸다(AWS-Demo-Platform 저장소의 ADR-011 `--v3` 드롭 결정과도
# 일치 — 이 repo 자신의 ADR-011(dashboard-deploy)과는 무관; 모델 카탈로그는 현재 v2/v3 동일).
# 에이전트 파일은 셀마다 `$CELL_CWD/.kiro/agents/` 로 복사한다 — HOME=$CELL_CWD 이므로
# 전역(~/.kiro/agents)·워크스페이스(.kiro/agents) 탐색 경로가 같은 디렉터리로 모인다.
# 향후 kiro-cli 가 이 시맨틱을 또 바꾸면 이 fail-closed 가정도 재검증 필요.
# 격리는 셀(모델×lens)마다 별도 서브디렉터리로 유지한다(co-agent PR 게이트의
# `_review_one`/`_sanitized_env`와 동일 패턴) — 툴 제거와 격리는 직교한 두 결정이다:
# 매트릭스의 모든 kiro 셀이 동시(&) 실행되므로, 셀 하나의 cwd/HOME 을 공유하면 kiro-cli
# 의 세션/캐시 상태가 병렬 실행 간 경합할 수 있다(fs_read 제거 리팩토링에서 "cross-run
# 전이 예방"으로만 재서술되며 이 경합 방지 목적이 소리 없이 빠졌던 회귀 — PR#107 리뷰가
# 4개 모델 교차 합의로 잡음). 비-ephemeral 러너에서 $WORK 가 재사용돼도 매 실행 시작 시
# 베이스를 리셋해 이전 실행의 kiro-cwd 상태가 새 실행에 새지 않게 한다.
KIRO_CWD_BASE="$WORK/kiro-cwd"
[ -L "$KIRO_CWD_BASE" ] && { echo "run-panel.sh: \$KIRO_CWD_BASE is a symlink, refusing (TOCTOU guard)" >&2; exit 1; }
rm -rf "$KIRO_CWD_BASE"; mkdir -p "$KIRO_CWD_BASE"
KIRO_AGENT_NAME="pr-review-notools"
KIRO_AGENT_SRC="$DIR/agents/$KIRO_AGENT_NAME.json"
[ -f "$KIRO_AGENT_SRC" ] || { echo "run-panel.sh: kiro agent config missing: $KIRO_AGENT_SRC" >&2; exit 1; }
# 중복 JSON 키나 기본값 복원으로 툴이 살아나는 구성을 실행 전에 거부한다 — 이름이 어긋나면
# kiro-cli 는 폴백(위 KIRO_AGENT_FALLBACK_RE)으로 툴 있는 기본 에이전트를 태우고, `tools`
# 가 비어 있지 않으면 폴백 없이도 무툴 계약이 깨진다. 둘 다 모델 호출 전에 fail-fast.
if ! python3 - "$KIRO_AGENT_SRC" "$KIRO_AGENT_NAME" <<'PY'
import json, sys
def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate key")
        obj[key] = value
    return obj
try:
    with open(sys.argv[1]) as source:
        agent = json.load(source, object_pairs_hook=unique_object)
    valid = (agent["name"] == sys.argv[2] and agent["tools"] == []
             and agent["allowedTools"] == [] and agent["mcpServers"] == {}
             and agent["resources"] == [] and agent["useLegacyMcpJson"] is False)
    if not valid:
        raise ValueError("tool configuration")
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(1)
PY
then
  echo "run-panel.sh: invalid no-tools agent configuration: $KIRO_AGENT_SRC" >&2
  exit 1
fi
prepare_kiro_agent() {
  local CELL_CWD="$1"
  mkdir -p "$CELL_CWD/.kiro/agents" && cp "$KIRO_AGENT_SRC" "$CELL_CWD/.kiro/agents/"
}
kiro_env() {
  local cell_cwd="$1"; shift
  env -i PATH="$PATH" HOME="$cell_cwd" LANG="${LANG:-}" LC_ALL="${LC_ALL:-}" TMPDIR="${TMPDIR:-/tmp}" \
    ${KIRO_API_KEY:+KIRO_API_KEY="$KIRO_API_KEY"} "$@"
}

# diff 는 size-capped argv 텍스트로 직접 embed — 단일 argv 128KiB 커널 한도(MAX_ARG_STRLEN)
# 아래로 캡한다. argv 임베드를 원래 피했던 이유(그 한도, `ps` 노출)는 여기선 실질적
# 트레이드오프가 아니다: (1) PANEL_CELL_CAP 캡핑 관례를 diff 입력에도 그대로 적용해 한도
# 아래로 자르고, (2) 이 diff 는 public repo 의 PR diff 라 이미 GitHub 에 공개돼 있으므로
# `ps` 가시성이 새로운 기밀 노출이 아니다(공식 secret 이 아님).
KIRO_DIFF_CAP="${KIRO_DIFF_CAP:-100000}"
KIRO_DIFF_TEXT="$(head -c "$KIRO_DIFF_CAP" "$DIFF")"
# truncation 자체는 무해(대형 diff 의 의도된 트레이드오프)하지만, 신호 없이 넘어가면 Kiro
# 셀은 prefix 만 보고도 정상 응답으로 집계돼 "벤더 하나가 diff 일부만 보면 coverage 신호를
# 남긴다"는 계약을 조용히 어긴다 — synthesize.sh 가 리뷰 본문에 명시하도록 플래그 파일로 전달.
if [ "$(wc -c < "$DIFF")" -gt "$KIRO_DIFF_CAP" ]; then
  KIRO_DIFF_TEXT+=$'\n[...TRUNCATED at '"$KIRO_DIFF_CAP"'B — full diff not sent to Kiro...]'
  echo "::warning::diff exceeds KIRO_DIFF_CAP (${KIRO_DIFF_CAP}B) — Kiro cells only see a truncated prefix" >&2
  : > "$WORK/kiro-diff-truncated.flag"
fi

for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  LENS_PROMPT="$(cat "$lens_file")"

  # Codex 셀 (Bedrock, config.toml — 모델 문자열은 이 repo 코드가 아니라 러너 이미지의
  # ~/.codex/config.toml 이 결정하며, 그 값이 global.openai.gpt-6-astra(amazon-bedrock-runtime
  # provider); KIRO_MODELS 의 gpt-5.6-terra 와는 별개 문자열이자 별개 provider — Kiro 의
  # cross-vendor 라우터 카탈로그와 Codex 자체 Bedrock 카탈로그가 서로 다른 alias 를 매핑하므로,
  # 하나가 다른 하나의 오타/drift가 아니다). --skip-git-repo-check 필수. global.openai.gpt-6-astra
  # 는 global 모델이라 region pinning 불필요(이전 gpt-5.6-sol/bedrock-mantle 은 In-Region
  # us-east-1 전용이었음). diff 는 stdin.
  if command -v codex >/dev/null 2>&1; then
    ( try_panel codex "$SLOT/codex-$lens.md" "$SLOT/codex-$lens.err" \
        timeout "$T" codex exec -s read-only --skip-git-repo-check "$LENS_PROMPT" ) &
  else echo "[skip] codex/$lens (binary absent)" >&2; : > "$SLOT/codex-$lens.md"; fi

  # Kiro x2 셀 — model:tag 를 한 배열에서 파생(호출/집계 동기화). Kiro's non-interactive
  # `chat` reads ONLY the prompt arg — it ignores stdin, so diff 는 argv 에 직접 embed(캡됨,
  # 툴 미부여 — 위 KIRO_DIFF_TEXT/`--agent pr-review-notools` 주석 참조).
  KIRO_INSTRUCTION="$LENS_PROMPT"$'\n\n'"Review ONLY the diff below; do not read or reference any other files:"$'\n\n'"$KIRO_DIFF_TEXT"
  for entry in "${KIRO_MODELS[@]}"; do
    m="${entry%%:*}"; tag="${entry##*:}"
    if command -v kiro-cli >/dev/null 2>&1; then
      CELL_CWD="$KIRO_CWD_BASE/$tag-$lens"
      prepare_kiro_agent "$CELL_CWD" \
        || { echo "run-panel.sh: failed to prepare Kiro review agent: $CELL_CWD" >&2; exit 1; }
      ( cd "$CELL_CWD" && try_panel kiro "$SLOT/$tag-$lens.md" "$SLOT/$tag-$lens.err" \
          kiro_env "$CELL_CWD" timeout "$T" kiro-cli chat "$KIRO_INSTRUCTION" --model "$m" \
          --agent "$KIRO_AGENT_NAME" --no-interactive --wrap never ) &
    else echo "[skip] $tag/$lens (binary absent)" >&2; : > "$SLOT/$tag-$lens.md"; fi
  done
done

# NOTE: Antigravity(agy) 는 제거됨 — OAuth 인터랙티브 로그인 전용(API 키 인증 모드 없음)
# 이라 헤드리스 CI 에서 인증 불가. 패널 = Codex + Kiro x2 → Claude 의장.
wait

# 결과 집계 (KIRO_MODELS·LENS_FILES 와 동일 소스에서 태그 파생 → 하드코딩 불일치 방지)
for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  record_result "$SLOT/codex-$lens.md" "codex/$lens" "$RESP"
  for entry in "${KIRO_MODELS[@]}"; do
    tag="${entry##*:}"; record_result "$SLOT/$tag-$lens.md" "$tag/$lens" "$RESP"
  done
done
echo "Panel responded ($(wc -l < "$RESP") / $(( (${#KIRO_MODELS[@]} + 1) * ${#LENS_FILES[@]} )) cells): $(tr '\n' ' ' < "$RESP")"

# 커버리지 floor — 모델 하나(플래그 무효화/바이너리 부재/전면 인증 실패 등)가 lens 전부에서
# 응답 없으면, 매트릭스가 조용히 그 모델 없이 축소된 채 VERDICT: PASS 로 이어질 수 있다
# (예: kiro-cli 플래그/`--agent` 가 이 러너에서 무효거나 모델 ID 가 계정에 프로비저닝 안
# 되면 Kiro 8셀 전부 graceful skip → 실질 4셀짜리 리뷰인데 코멘트만 봐선 눈에 안 띌 수 있음).
# 모델별 row 가 완전히 비면 경고 + synthesize.sh 가 리뷰 본문에 명시하도록 파일로 전달.
TOTAL_MODELS=$(( ${#KIRO_MODELS[@]} + 1 ))
: > "$WORK/degraded-models.txt"
for model_tag in codex "${KIRO_MODELS[@]##*:}"; do
  # grep -c 는 매치가 0건이어도 "0"을 찍고 exit 1 한다(매치 없음 = grep 관점의 "실패") —
  # `|| echo 0` 폴백을 붙이면 그 "0" 뒤에 폴백의 "0"이 또 붙어 "0\n0"이 되는 회귀가
  # 실제로 있었다(test (f)에서 잡힘). $RESP 는 run-panel.sh 시작부에 항상 만들어지므로
  # "파일 없음" 폴백 자체가 불필요 — 그냥 grep 의 stdout 을 그대로 쓴다.
  # $RESP 가 예기치 않게 부재/비가독이면 grep 이 아무것도 못 찍어 row_count 가 빈 문자열이
  # 되고, `[ "" -eq 0 ]` 는 (set -e 없이) 조용히 false 로 삼켜져 degraded 경고 자체가
  # 빠진다 — 12차에서 잡은 responded.txt 부재 비대칭과 같은 부류(14차 리뷰 MINOR-1).
  row_count="$(grep -c "^${model_tag}/" "$RESP" 2>/dev/null)"
  if [ "${row_count:-0}" -eq 0 ]; then
    echo "::warning::model '$model_tag' produced zero responses across all ${#LENS_FILES[@]} lenses — coverage degraded" >&2
    echo "$model_tag" >> "$WORK/degraded-models.txt"
  fi
done

# 심각도 상향 — degraded 모델이 (전체-1)개 이상이면 살아남은 벤더가 최대 1개뿐이라, "매트릭스
# 자체가 lens당 교차확인"이라는 warn-only 의 전제(다른 모델이 여전히 같은 lens 를 본다)가
# 성립하지 않는다. 이 경우만 severe 로 승격해 synthesize.sh 가 VERDICT 를 강제 FAIL 하도록
# 신호를 남긴다(모델 1개 탈락은 여전히 warn-only 유지 — 간헐적 rate-limit 로도 흔하고, 남은
# 3개가 각 lens 를 여전히 교차확인하므로 이 PR 도입 시 설계한 대로 사람이 배너로만 인지해도
# 된다는 원 판단은 유효). 신규 kiro-cli 플래그가 처음 실전 투입되는 시점(2개 kiro 모델이
# 동시에 전멸하는 경우가 바로 이 기준을 정확히 친다)이 이 게이트가 노리는 실제 사례다.
DEGRADED_COUNT=$(wc -l < "$WORK/degraded-models.txt")
if [ "$DEGRADED_COUNT" -ge "$((TOTAL_MODELS - 1))" ]; then
  echo "::error::coverage collapsed to ≤1 vendor ($DEGRADED_COUNT/$TOTAL_MODELS models degraded) — forcing VERDICT: FAIL, no cross-model check remains for any lens" >&2
  : > "$WORK/coverage-severe.flag"
fi

# 에이전트 폴백 가시화 + severe 승격 — try_panel 이 남긴 `$slot.agentfail` 마커가 하나라도
# 있으면 그 러너의 kiro-cli 가 `--agent` 를 무시한 것이라 남은 Kiro 응답도 무툴 보장이 없다.
# 슬롯은 이미 비워져 있으므로(집계 제외) coverage 축으로도 잡히지만, 원인을 "빈 응답"이 아닌
# "계약 위반"으로 명시하고 체어 판정과 무관하게 FAIL 을 강제한다.
shopt -s nullglob
AGENTFAIL_MARKERS=("$SLOT"/*.agentfail)
shopt -u nullglob
if [ "${#AGENTFAIL_MARKERS[@]}" -gt 0 ]; then
  AGENTFAIL_DETAIL="$(cat "${AGENTFAIL_MARKERS[@]}" | scrub_secrets | grep -v '^\s*$' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  AGENTFAIL_CELLS="$(for q in "${AGENTFAIL_MARKERS[@]}"; do basename "$q" .md.agentfail; done | tr '\n' ' ' | sed 's/ *$//')"
  echo "::error::kiro-cli ignored --agent $KIRO_AGENT_NAME (fell back to the default agent WITH tools) in ${#AGENTFAIL_MARKERS[@]} cell(s) [$AGENTFAIL_CELLS]: $AGENTFAIL_DETAIL — responses discarded, forcing VERDICT: FAIL (no-tools contract)" >&2
  printf '%s\n' "$AGENTFAIL_DETAIL" > "$WORK/kiro-agent-fallback.flag"
  : > "$WORK/coverage-severe.flag"
  rm -f "${AGENTFAIL_MARKERS[@]}"
fi

# Kiro 월간 요청 한도 소진 가시화 — try_panel 이 남긴 `$slot.quota` 마커가 하나라도 있으면
# 위 degraded/severe 배너의 "플래그 무효·바이너리 부재·인증 실패 등" 추정 대신 실제 원인
# (KIRO_API_KEY 계정의 MONTHLY_REQUEST_COUNT 한도, 리셋 날짜)을 로그와 리뷰 코멘트에 명시한다.
# 한도는 이 러너 이미지를 공유하는 모든 repo 의 pr-review 가 같은 키로 소비하므로, 해소는
# 코드가 아니라 계정 측(overage 활성화 또는 AWS-Demo-Platform 저장소가 관리하는 Secrets
# Manager `/demo-platform/actions/AI-key` 의 KIRO_API_KEY 교체)에서만 가능하다. fail-closed
# 계약(coverage-severe → 강제 FAIL)은 그대로 둔다.
shopt -s nullglob
QUOTA_MARKERS=("$SLOT"/*.quota)
shopt -u nullglob
if [ "${#QUOTA_MARKERS[@]}" -gt 0 ]; then
  QUOTA_DETAIL="$(cat "${QUOTA_MARKERS[@]}" | scrub_secrets | grep -v '^\s*$' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  QUOTA_CELLS="$(for q in "${QUOTA_MARKERS[@]}"; do basename "$q" .md.quota; done | tr '\n' ' ' | sed 's/ *$//')"
  echo "::error::Kiro monthly request quota exhausted for KIRO_API_KEY — ${#QUOTA_MARKERS[@]} cell(s) [$QUOTA_CELLS]: $QUOTA_DETAIL — enable overages or rotate the key (/demo-platform/actions/AI-key); not a headless-flag failure" >&2
  printf '%s\n' "$QUOTA_DETAIL" > "$WORK/kiro-quota.flag"
  rm -f "${QUOTA_MARKERS[@]}"
fi

# skip 원인 노출: 빈 슬롯인데 stderr 가 있으면 stderr 의 끝(실제 에러)을 로그에 찍는다.
# public repo 라 이 Actions 로그는 누구나 읽을 수 있다 — synthesize.sh 의 셀과 동일한
# scrub_secrets() 를 통과시켜 stderr(에러 메시지·스택트레이스) 경로로 새어나올 수 있는
# 우발적 크리덴셜 노출을 막는다.
for e in "$SLOT"/*.err; do
  [ -s "$e" ] || continue
  b="$(basename "$e" .err)"
  [ -s "$SLOT/$b.md" ] && continue   # 응답 성공이면 건너뜀
  echo "--- [$b] skipped; stderr (last 25 lines, scrubbed) ---" >&2
  tail -25 "$e" | scrub_secrets >&2
done
