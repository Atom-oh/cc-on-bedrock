#!/usr/bin/env bash
# cc-bedrock-local — Local Governance Mode CLI (ADR-014)
#
# Subcommands:
#   login         password prompt → Cognito USER_PASSWORD_AUTH → STS issue
#   refresh       silent only (cached refresh token; fails if expired)
#   logout        clear cached refresh token + state
#   change-email  prompt new email (+ password) and persist to config
#   status        remaining TTL + Deny / limit state
#   claude [args] ensure session + apply model env from config, then exec 'claude'
#   set-model K=V (or K V) — update model env in config. Keys (aliases ok):
#                 opus | default-opus | fast | small | subagent
#                 (or full: ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL,
#                  ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_SUBAGENT_MODEL)
#   models        print current model env + suggested ids
#   run -- <cmd>  generic wrapper: ensure session, exec <cmd> (no claude env)
#   config        print current config / file paths
#
# Config file: ~/.config/cc-bedrock/config (mode 600). Required keys:
#   DASHBOARD_URL, COGNITO_REGION, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, EMAIL
# Optional model keys (see set-model above): default to values set at install.

set -euo pipefail

CFG_DIR="${HOME}/.config/cc-bedrock"
CFG_FILE="${CFG_DIR}/config"
STATE_FILE="${CFG_DIR}/state.json"
TOKEN_CACHE="${CFG_DIR}/cognito-tokens.json"
AWS_CREDS_FILE="${HOME}/.aws/credentials"

mkdir -p "${CFG_DIR}"

if [[ -f "${CFG_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${CFG_FILE}"; set +a
fi

DASHBOARD_URL="${CC_BEDROCK_DASHBOARD_URL:-${DASHBOARD_URL:-}}"
COGNITO_REGION="${COGNITO_REGION:-ap-northeast-2}"
COGNITO_USER_POOL_ID="${COGNITO_USER_POOL_ID:-}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-}"
EMAIL="${CC_BEDROCK_EMAIL:-${EMAIL:-}}"
AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-cc-bedrock}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"

# Model env (defaults shipped here; user can override via 'set-model')
# Default: Sonnet (cheaper / faster than Opus). Use 'cc --set-model opus=...' to switch.
ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-global.anthropic.claude-sonnet-4-6}"
ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-global.anthropic.claude-sonnet-4-6}"
ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-us.anthropic.claude-haiku-4-5-20251001-v1:0}"
CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-global.anthropic.claude-sonnet-4-6}"

die() { echo "cc-bedrock-local: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
say() { echo "cc-bedrock-local: $*" >&2; }

require_config() {
  [[ -n "${DASHBOARD_URL}" ]] || die "DASHBOARD_URL not set (edit ${CFG_FILE})"
  [[ -n "${COGNITO_CLIENT_ID}" ]] || die "COGNITO_CLIENT_ID not set (edit ${CFG_FILE})"
  have curl     || die "curl is required"
  have python3  || die "python3 is required"
}

epoch_now() { date -u +%s; }

iso_to_epoch() {
  local iso="$1"
  if date -u -d "${iso}" +%s 2>/dev/null; then return; fi
  if date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${iso%%.*}Z" +%s 2>/dev/null; then return; fi
  if have python3; then
    python3 -c "import sys,datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')).timestamp()))" "${iso}"
    return
  fi
  echo 0
}

prompt_tty() {  # prompt_tty <varname> <prompt> [-s for silent]
  local var="$1" prompt="$2" silent="${3:-}"
  local val=""
  if [[ ! -e /dev/tty ]]; then die "no /dev/tty — cannot prompt for ${var}"; fi
  if [[ "${silent}" == "-s" ]]; then
    read -s -p "${prompt}" val < /dev/tty
    echo "" >&2
  else
    read -p "${prompt}" val < /dev/tty
  fi
  printf -v "${var}" '%s' "${val}"
}

config_set() {  # config_set KEY VALUE  (idempotent KEY=VALUE in CFG_FILE)
  local key="$1" val="$2"
  touch "${CFG_FILE}"
  chmod 600 "${CFG_FILE}"
  python3 - "${CFG_FILE}" "${key}" "${val}" <<'PY'
import sys, re
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
content = open(path).read() if open(path) else ""
pattern = rf"^{re.escape(key)}=.*$"
if re.search(pattern, content, flags=re.M):
    content = re.sub(pattern, f"{key}={val}", content, flags=re.M)
else:
    content = content.rstrip() + f"\n{key}={val}\n"
open(path, "w").write(content)
PY
}

cognito_login_request() {  # cognito_login_request <email> <password>
  local body
  body=$(python3 -c "
import json, sys
print(json.dumps({
  'AuthFlow': 'USER_PASSWORD_AUTH',
  'ClientId': sys.argv[1],
  'AuthParameters': { 'USERNAME': sys.argv[2], 'PASSWORD': sys.argv[3] },
}))
" "${COGNITO_CLIENT_ID}" "$1" "$2")
  curl -sS -X POST \
    -H 'Content-Type: application/x-amz-json-1.1' \
    -H 'X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth' \
    "https://cognito-idp.${COGNITO_REGION}.amazonaws.com/" \
    --data "${body}"
}

cognito_refresh_request() {  # cognito_refresh_request <refresh_token>
  local body
  body=$(python3 -c "
import json, sys
print(json.dumps({
  'AuthFlow': 'REFRESH_TOKEN_AUTH',
  'ClientId': sys.argv[1],
  'AuthParameters': { 'REFRESH_TOKEN': sys.argv[2] },
}))
" "${COGNITO_CLIENT_ID}" "$1")
  curl -sS -X POST \
    -H 'Content-Type: application/x-amz-json-1.1' \
    -H 'X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth' \
    "https://cognito-idp.${COGNITO_REGION}.amazonaws.com/" \
    --data "${body}"
}

cache_tokens() {  # cache_tokens <access> <refresh>
  python3 -c "
import json, sys, time
json.dump({
  'accessToken': sys.argv[1],
  'refreshToken': sys.argv[2],
  'obtainedAt': int(time.time()),
}, open(sys.argv[3], 'w'))
" "$1" "$2" "${TOKEN_CACHE}"
  chmod 600 "${TOKEN_CACHE}"
}

sts_exchange() {  # sts_exchange <access_token>
  curl -sS -X POST \
    -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" \
    "${DASHBOARD_URL%/}/api/local/credentials" \
    --data '{}'
}

write_aws_creds() {  # write_aws_creds <sts_response_json>
  local snippet
  snippet="$(echo "$1" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["profileSnippet"])')"
  mkdir -p "$(dirname "${AWS_CREDS_FILE}")"
  touch "${AWS_CREDS_FILE}"
  chmod 600 "${AWS_CREDS_FILE}"
  python3 - "${AWS_CREDS_FILE}" "${AWS_PROFILE_NAME}" "${snippet}" <<'PY'
import sys, re, os
path, profile, snippet = sys.argv[1], sys.argv[2], sys.argv[3]
content = open(path).read() if os.path.exists(path) else ""
content = re.sub(rf"\[{re.escape(profile)}\].*?(?=^\[|\Z)", "", content, flags=re.M | re.S).rstrip() + "\n"
snippet = re.sub(r"\[cc-bedrock\]", f"[{profile}]", snippet, count=1)
open(path, "w").write(content + "\n" + snippet.rstrip() + "\n")
PY
}

save_state() { echo "$1" > "${STATE_FILE}"; chmod 600 "${STATE_FILE}"; }

# Extract a field from a Cognito InitiateAuth response (or print error to stderr).
parse_cognito_token() {  # parse_cognito_token <field>  (e.g. AccessToken / RefreshToken)
  python3 -c "
import json, sys
d = json.load(sys.stdin)
auth = d.get('AuthenticationResult')
if not auth:
    err = d.get('message') or d.get('__type') or 'unknown error'
    sys.stderr.write(f'cognito error: {err}\n')
    sys.exit(1)
print(auth.get(sys.argv[1], '') or '')
" "$1"
}

# ─── login (password prompt, email from config) ─────────────
do_login() {
  require_config
  if [[ -z "${EMAIL}" ]]; then
    say "EMAIL not set in ${CFG_FILE} — use 'change-email' first"
    do_change_email
    return $?
  fi
  echo "Email: ${EMAIL}"
  local password
  prompt_tty password "Password: " -s
  [[ -n "${password}" ]] || die "password is empty"

  local resp access_token refresh_token
  resp=$(cognito_login_request "${EMAIL}" "${password}")
  access_token=$(echo "${resp}" | parse_cognito_token "AccessToken")
  refresh_token=$(echo "${resp}" | parse_cognito_token "RefreshToken")
  [[ -n "${access_token}" ]] || die "Cognito did not return AccessToken"
  cache_tokens "${access_token}" "${refresh_token}"
  echo "✓ login OK"
  issue_sts "${access_token}"
}

# ─── refresh (silent) ───────────────────────────────────────
do_refresh() {
  require_config
  [[ -f "${TOKEN_CACHE}" ]] || { say "no cached session — run 'cc-bedrock-local login'"; return 2; }
  local refresh_token
  refresh_token=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("refreshToken","") or "")' "${TOKEN_CACHE}" 2>/dev/null || true)
  [[ -n "${refresh_token}" ]] || { say "no refresh token cached — run 'cc-bedrock-local login'"; return 2; }

  local resp access_token
  resp=$(cognito_refresh_request "${refresh_token}")
  access_token=$(echo "${resp}" | parse_cognito_token "AccessToken" 2>/dev/null || echo "")
  if [[ -z "${access_token}" ]]; then
    say "refresh token expired or rejected — re-login required"
    return 2
  fi
  # Refresh response keeps the same refresh token (Cognito doesn't rotate by default)
  cache_tokens "${access_token}" "${refresh_token}"
  echo "✓ silent refresh OK"
  issue_sts "${access_token}"
}

# Helper: exchange a Cognito AccessToken for STS creds via Dashboard
issue_sts() {  # issue_sts <access_token>
  local sts_resp
  sts_resp=$(sts_exchange "$1")
  if echo "${sts_resp}" | python3 -c 'import json,sys; sys.exit(0 if "credentials" in json.loads(sys.stdin.read()) else 1)' 2>/dev/null; then
    write_aws_creds "${sts_resp}"
    save_state "${sts_resp}"
    local exp
    exp="$(echo "${sts_resp}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["credentials"]["expiration"])')"
    echo "✓ STS credentials written: profile=${AWS_PROFILE_NAME}, expires=${exp}"
  else
    echo "${sts_resp}" >&2
    die "dashboard refused STS issue"
  fi
}

# ─── logout (clear cache + state) ───────────────────────────
do_logout() {
  rm -f "${TOKEN_CACHE}" "${STATE_FILE}"
  echo "✓ cached session cleared (next 'cc' will prompt for password)"
}

# ─── change-email (re-set + re-login) ───────────────────────
do_change_email() {
  require_config
  local new_email
  prompt_tty new_email "New Cognito email: "
  [[ -n "${new_email}" ]] || die "email is empty"
  config_set EMAIL "${new_email}"
  EMAIL="${new_email}"
  # Force re-login (refresh tokens belong to old account)
  rm -f "${TOKEN_CACHE}" "${STATE_FILE}"
  echo "✓ email updated to ${new_email} — re-authenticating..."
  do_login
}

# ─── run (ensure session, then exec) ────────────────────────
do_run() {
  local found=0 args=()
  for a in "$@"; do
    (( found )) && args+=("$a")
    [[ "$a" == "--" ]] && found=1
  done
  (( found )) || die "usage: cc-bedrock-local run -- <command> [args...]"

  local need_action="none"

  # State file valid?
  if [[ -f "${STATE_FILE}" ]]; then
    local exp exp_e now_e
    exp="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["credentials"]["expiration"])' "${STATE_FILE}" 2>/dev/null || true)"
    if [[ -n "${exp}" ]]; then
      exp_e="$(iso_to_epoch "${exp}")"; now_e="$(epoch_now)"
      if (( exp_e - now_e > 600 )); then
        :  # valid for at least 10 more minutes
      else
        need_action="refresh"
      fi
    else
      need_action="refresh"
    fi
  else
    need_action="refresh"
  fi

  if [[ "${need_action}" == "refresh" ]]; then
    # Try silent refresh first; if that fails, fall through to login
    if ! do_refresh >/dev/null 2>&1; then
      do_login
    fi
  fi

  CLAUDE_CODE_USE_BEDROCK=1 \
    AWS_PROFILE="${AWS_PROFILE_NAME}" \
    AWS_REGION="${AWS_REGION}" \
    exec "${args[@]}"
}

# ─── claude (ensure session + apply model env + exec claude) ─
do_claude() {
  # Ensure credentials before exec (reuse run's logic)
  local need_action="none"
  if [[ -f "${STATE_FILE}" ]]; then
    local exp exp_e now_e
    exp="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["credentials"]["expiration"])' "${STATE_FILE}" 2>/dev/null || true)"
    if [[ -n "${exp}" ]]; then
      exp_e="$(iso_to_epoch "${exp}")"; now_e="$(epoch_now)"
      (( exp_e - now_e > 600 )) || need_action="refresh"
    else
      need_action="refresh"
    fi
  else
    need_action="refresh"
  fi
  if [[ "${need_action}" == "refresh" ]]; then
    if ! do_refresh >/dev/null 2>&1; then
      do_login
    fi
  fi

  echo "[Bedrock] model=${ANTHROPIC_MODEL} (fast=${ANTHROPIC_SMALL_FAST_MODEL})"
  CLAUDE_CODE_USE_BEDROCK=1 \
    AWS_PROFILE="${AWS_PROFILE_NAME}" \
    AWS_REGION="${AWS_REGION}" \
    ANTHROPIC_MODEL="${ANTHROPIC_MODEL}" \
    ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL}" \
    ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL}" \
    CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL}" \
    exec claude --dangerously-skip-permissions "$@"
}

# ─── set-model (update config) ──────────────────────────────
do_set_model() {
  [[ -n "${1:-}" ]] || die "usage: set-model <key>=<value>  OR  set-model <key> <value>"
  local raw="$1" key val
  if [[ "${raw}" == *=* ]]; then
    key="${raw%%=*}"; val="${raw#*=}"
  else
    key="${raw}"; shift; val="${1:-}"
    [[ -n "${val}" ]] || die "value missing"
  fi
  case "${key}" in
    opus|model|ANTHROPIC_MODEL)                          key="ANTHROPIC_MODEL" ;;
    default-opus|opus1m|ANTHROPIC_DEFAULT_OPUS_MODEL)    key="ANTHROPIC_DEFAULT_OPUS_MODEL" ;;
    fast|small|haiku|ANTHROPIC_SMALL_FAST_MODEL)         key="ANTHROPIC_SMALL_FAST_MODEL" ;;
    subagent|CLAUDE_CODE_SUBAGENT_MODEL)                 key="CLAUDE_CODE_SUBAGENT_MODEL" ;;
    *) die "unknown model key: ${key} (use opus|default-opus|fast|subagent)" ;;
  esac
  config_set "${key}" "${val}"
  echo "✓ ${key}=${val} (saved to ${CFG_FILE})"
}

# ─── models (display) ───────────────────────────────────────
do_models() {
  cat <<EOF
Current model env (from ${CFG_FILE} or defaults):
  ANTHROPIC_MODEL              = ${ANTHROPIC_MODEL}
  ANTHROPIC_DEFAULT_OPUS_MODEL = ${ANTHROPIC_DEFAULT_OPUS_MODEL}
  ANTHROPIC_SMALL_FAST_MODEL   = ${ANTHROPIC_SMALL_FAST_MODEL}
  CLAUDE_CODE_SUBAGENT_MODEL   = ${CLAUDE_CODE_SUBAGENT_MODEL}

Examples:
  cc-bedrock-local set-model opus=global.anthropic.claude-sonnet-4-6
  cc-bedrock-local set-model fast us.anthropic.claude-haiku-4-5-20251001-v1:0
  cc-bedrock-local set-model default-opus 'global.anthropic.claude-opus-4-7[1m]'

Aliases: opus|model | default-opus|opus1m | fast|small|haiku | subagent
EOF
}

do_status() {
  if [[ ! -f "${STATE_FILE}" ]]; then
    echo "no session — run 'cc' or 'cc-bedrock-local login'"
    return 1
  fi
  python3 - "${STATE_FILE}" "${TOKEN_CACHE}" "${EMAIL:-}" <<'PY'
import json, sys, datetime, os
state = json.load(open(sys.argv[1]))
creds = state.get("credentials", {})
limit = state.get("limitStatus", {})
print(f"email         : {sys.argv[3] or '(unset)'}")
print(f"role_arn      : {state.get('roleArn','-')}")
print(f"region        : {state.get('region','-')}")
print(f"expiration    : {creds.get('expiration','-')}")
try:
    expdt = datetime.datetime.fromisoformat(creds["expiration"].replace("Z","+00:00"))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(f"remaining     : {expdt - now}")
except Exception:
    pass
print(f"deny active   : {limit.get('denyActive', False)}")
if limit.get("denyActive"):
    print(f"  reason      : {limit.get('denyReason')}")
    print(f"  reset_at    : {limit.get('resetAt')}")
if os.path.exists(sys.argv[2]):
    tk = json.load(open(sys.argv[2]))
    age = int(datetime.datetime.utcnow().timestamp() - tk.get("obtainedAt", 0))
    print(f"cognito cache : present (age {age // 60}m)")
else:
    print("cognito cache : (absent — next refresh will prompt for password)")
PY
}

do_config() {
  cat <<EOF
config file        : ${CFG_FILE}
state file         : ${STATE_FILE}
cognito token cache: ${TOKEN_CACHE}
DASHBOARD_URL      : ${DASHBOARD_URL:-(unset)}
COGNITO_REGION     : ${COGNITO_REGION}
COGNITO_USER_POOL  : ${COGNITO_USER_POOL_ID:-(unset)}
COGNITO_CLIENT_ID  : ${COGNITO_CLIENT_ID:-(unset)}
EMAIL              : ${EMAIL:-(unset)}
AWS_PROFILE        : ${AWS_PROFILE_NAME}
AWS_REGION         : ${AWS_REGION}
EOF
}

do_usage() {
  cat <<EOF
cc-bedrock-local — Local Governance Mode CLI (ADR-014)

Subcommands:
  login                       prompt password (email from config) → login + STS issue
  refresh                     silent only — uses cached refresh token
  logout                      clear cached session
  change-email                prompt new email + password, update config, re-login
  status                      session state + limit/deny state
  claude [args]               ensure session + apply model env from config, exec claude
  set-model KEY=VAL           change model env in config (alias keys: opus|fast|subagent|default-opus)
  models                      show current model env + valid keys
  run -- <cmd> [args]         generic: ensure session, exec <cmd> (no claude env)
  config                      print config / file paths

Config file: ${CFG_FILE}
EOF
}

sub="${1:-}"; shift || true
case "${sub}" in
  login)        do_login "$@" ;;
  refresh)      do_refresh "$@" ;;
  logout)       do_logout ;;
  change-email|change_email) do_change_email ;;
  status)       do_status "$@" ;;
  run)          do_run "$@" ;;
  claude)       do_claude "$@" ;;
  set-model|set_model) do_set_model "$@" ;;
  models)       do_models ;;
  config)       do_config ;;
  ""|-h|--help|help) do_usage ;;
  *) die "unknown subcommand: ${sub}" ;;
esac
