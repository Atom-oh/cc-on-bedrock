#!/usr/bin/env bash
# Lightweight CC-on-Bedrock productivity telemetry.
#
# This intentionally emits low-cardinality event metrics only. It avoids the old
# full-workspace scan loop, which was expensive on large repos and hard to
# interpret as Claude productivity.
set -euo pipefail

HEARTBEAT_MINUTES="${CC_OTEL_HEARTBEAT_MINUTES:-5}"
ENDPOINT="${CC_OTEL_ENDPOINT:-${OTEL_EXPORTER_OTLP_ENDPOINT:-${OTEL_COLLECTOR_ENDPOINT:-}}}"

script_abspath() {
  local src="$0"
  if [[ "${src}" != */* ]]; then
    src="$(command -v -- "${src}" 2>/dev/null || true)"
  fi
  if command -v readlink >/dev/null 2>&1; then
    readlink -f "${src}" 2>/dev/null && return
  fi
  python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${src}"
}

normalize_endpoint() {
  [[ -n "${ENDPOINT}" ]] || return 1
  if [[ "${ENDPOINT}" != */v1/metrics ]]; then
    ENDPOINT="${ENDPOINT%/}/v1/metrics"
  fi
}

emit_metrics() {
  normalize_endpoint || return 0
  command -v curl >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  local payload
  payload="$(
    python3 - "$@" <<'PY'
import json
import os
import socket
import sys
import time

now = str(time.time_ns())
host_id = os.environ.get("INSTANCE_ID") or os.environ.get("HOSTNAME") or socket.gethostname() or "unknown"
mode = os.environ.get("CC_DEPLOY_MODE") or os.environ.get("DEPLOY_MODE")
if not mode:
    mode = "ec2" if os.environ.get("USER_SUBDOMAIN") else "local"
department = (
    os.environ.get("USER_DEPARTMENT")
    or os.environ.get("DEPARTMENT")
    or os.environ.get("CC_DEPARTMENT")
    or "default"
)

attrs = [
    {"key": "service.name", "value": {"stringValue": "cc-on-bedrock-productivity"}},
    {"key": "host.id", "value": {"stringValue": host_id}},
    {"key": "cc.mode", "value": {"stringValue": mode}},
    {"key": "cc.department", "value": {"stringValue": department}},
]

raw_user = (
    os.environ.get("USER_EMAIL")
    or os.environ.get("EMAIL")
    or os.environ.get("USER_SUBDOMAIN")
    or os.environ.get("USER")
    or ""
).strip().lower()
if raw_user:
    # enduser.id flows only to the internal collector -> S3 -> rollup path
    # (ADR-009: per-user aggregate is email-keyed; the CloudWatch path is removed).
    attrs.append({"key": "enduser.id", "value": {"stringValue": raw_user}})

metrics = []
args = sys.argv[1:]
if len(args) % 4 != 0:
    raise SystemExit("metrics must be name/value/unit/description groups")
for i in range(0, len(args), 4):
    name, raw_value, unit, description = args[i:i + 4]
    try:
        value = int(float(raw_value))
    except Exception:
        value = 0
    metrics.append({
        "name": name,
        "description": description,
        "unit": unit,
        "gauge": {"dataPoints": [{"timeUnixNano": now, "asInt": value}]},
    })

print(json.dumps({
    "resourceMetrics": [{
        "resource": {"attributes": attrs},
        "scopeMetrics": [{
            "scope": {"name": "cc-otel-code-metrics", "version": "2.0.0"},
            "metrics": metrics,
        }],
    }],
}, separators=(",", ":")))
PY
  )"

  curl -fsS -m 3 -X POST \
    -H "Content-Type: application/json" \
    --data "${payload}" \
    "${ENDPOINT}" >/dev/null 2>&1 || true
}

session_start() {
  emit_metrics \
    "cc.claude.sessions.started" "1" "1" "Claude Code sessions started"
}

session_end() {
  local duration="${1:-0}"
  emit_metrics \
    "cc.claude.sessions.ended" "1" "1" "Claude Code sessions ended" \
    "cc.claude.session.duration_seconds" "${duration}" "s" "Claude Code session duration"
}

claude_running() {
  local uid
  uid="$(id -u)"
  pgrep -u "${uid}" -f '(^|/)claude([[:space:]]|$)' >/dev/null 2>&1
}

heartbeat() {
  local force="${1:-}"
  if [[ "${force}" == "--force" ]] || claude_running; then
    emit_metrics \
      "cc.claude.heartbeat" "1" "1" "Claude Code active heartbeat" \
      "cc.claude.active_minutes" "${HEARTBEAT_MINUTES}" "min" "Approximate active Claude Code minutes"
  fi
}

git_commit() {
  command -v git >/dev/null 2>&1 || return 0
  local counts added deleted
  counts="$(
    python3 - <<'PY'
import subprocess

try:
    output = subprocess.check_output(
        ["git", "show", "--numstat", "--format=", "HEAD"],
        text=True,
        stderr=subprocess.DEVNULL,
    )
except Exception:
    print("0 0")
    raise SystemExit(0)

added = 0
deleted = 0
for line in output.splitlines():
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 3:
        continue
    try:
        added += int(parts[0])
        deleted += int(parts[1])
    except ValueError:
        continue
print(f"{added} {deleted}")
PY
  )"
  added="${counts%% *}"
  deleted="${counts##* }"
  emit_metrics \
    "cc.git.commits" "1" "1" "Successful git commits" \
    "cc.git.lines_added" "${added:-0}" "1" "Lines added in successful git commits" \
    "cc.git.lines_deleted" "${deleted:-0}" "1" "Lines deleted in successful git commits"
}

git_push() {
  emit_metrics \
    "cc.git.pushes" "1" "1" "Successful git pushes"
}

install_git_wrapper() {
  local target="${1:-}"
  local real_git="${2:-/usr/bin/git}"
  [[ -n "${target}" ]] || { echo "usage: $0 install-git-wrapper <target> [real_git]" >&2; return 2; }
  [[ -x "${real_git}" ]] || real_git="$(command -v git 2>/dev/null || true)"
  [[ -n "${real_git}" ]] || { echo "git not found" >&2; return 0; }

  mkdir -p "$(dirname "${target}")"
  if [[ -e "${target}" ]] && ! grep -q "cc-otel git wrapper" "${target}" 2>/dev/null; then
    echo "not overwriting existing git at ${target}" >&2
    return 0
  fi

  local emitter
  emitter="$(script_abspath)"
  cat > "${target}" <<EOF
#!/usr/bin/env bash
# cc-otel git wrapper
set -uo pipefail
REAL_GIT="${real_git}"
EMITTER="${emitter}"

metric_cwd="\${PWD}"
cmd=""
args=("\$@")
i=0
while (( i < \${#args[@]} )); do
  case "\${args[\$i]}" in
    -C)
      if (( i + 1 < \${#args[@]} )); then metric_cwd="\${args[\$((i+1))]}"; fi
      i=\$((i + 2))
      ;;
    -c|--git-dir|--work-tree)
      i=\$((i + 2))
      ;;
    --git-dir=*|--work-tree=*)
      i=\$((i + 1))
      ;;
    -*)
      i=\$((i + 1))
      ;;
    *)
      cmd="\${args[\$i]}"
      break
      ;;
  esac
done

"\${REAL_GIT}" "\$@"
status=\$?
if [[ "\${status}" -eq 0 ]]; then
  case "\${cmd}" in
    commit) (cd "\${metric_cwd}" 2>/dev/null && "\${EMITTER}" git-commit >/dev/null 2>&1) || true ;;
    push)   (cd "\${metric_cwd}" 2>/dev/null && "\${EMITTER}" git-push >/dev/null 2>&1) || true ;;
  esac
fi
exit "\${status}"
EOF
  chmod +x "${target}"
}

install_claude_wrapper() {
  local target="${1:-}"
  local real_claude="${2:-}"
  [[ -n "${target}" && -n "${real_claude}" ]] || {
    echo "usage: $0 install-claude-wrapper <target> <real_claude>" >&2
    return 2
  }
  [[ -x "${real_claude}" ]] || return 0

  local emitter
  emitter="$(script_abspath)"
  cat > "${target}" <<EOF
#!/usr/bin/env bash
# cc-otel claude wrapper
set -uo pipefail
REAL_CLAUDE="${real_claude}"
EMITTER="${emitter}"
start_epoch=\$(date -u +%s)
export CC_OTEL_SESSION_ID="\$(date -u +%Y%m%dT%H%M%SZ)-\$\$"

"\${EMITTER}" session-start >/dev/null 2>&1 || true
"\${REAL_CLAUDE}" "\$@"
status=\$?
end_epoch=\$(date -u +%s)
duration=\$((end_epoch - start_epoch))
"\${EMITTER}" session-end "\${duration}" >/dev/null 2>&1 || true
exit "\${status}"
EOF
  chmod +x "${target}"
}

usage() {
  cat <<EOF
usage: $0 <command>

Commands:
  session-start                         emit one Claude session start
  session-end [duration_seconds]         emit one Claude session end and duration
  heartbeat [--force]                    emit a 5-minute active heartbeat when Claude is running
  git-commit                             emit one commit plus added/deleted lines for HEAD
  git-push                               emit one successful push
  install-git-wrapper <target> [git]     install a non-invasive git wrapper
  install-claude-wrapper <target> <real> install a Claude session wrapper
EOF
}

cmd="${1:-heartbeat}"
shift || true
case "${cmd}" in
  session-start) session_start "$@" ;;
  session-end) session_end "$@" ;;
  heartbeat) heartbeat "$@" ;;
  git-commit) git_commit "$@" ;;
  git-push) git_push "$@" ;;
  install-git-wrapper) install_git_wrapper "$@" ;;
  install-claude-wrapper) install_claude_wrapper "$@" ;;
  -h|--help|help) usage ;;
  *) echo "unknown command: ${cmd}" >&2; usage >&2; exit 2 ;;
esac
