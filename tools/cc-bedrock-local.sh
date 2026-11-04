#!/usr/bin/env bash
# cc-bedrock-local — Local Governance Mode CLI (ADR-006 (legacy ADR-014))
#
# Subcommands:
#   login         password prompt → Cognito USER_PASSWORD_AUTH → STS issue
#   refresh       silent only (cached refresh token; fails if expired)
#   credential-process  AWS SDK credential_process hook (ADR-029) — emits
#                 {"Version":1,AccessKeyId,...,Expiration} JSON. Serves from
#                 cache while TTL > 5min, silently re-issues otherwise. Never
#                 prompts; exits 1 with a re-login hint when the Cognito
#                 refresh token is dead. Wired into ~/.aws/config so the SDK
#                 auto-refreshes MID-SESSION — long claude sessions no longer
#                 die at the 1h STS role-chaining cap.
#   logout        clear cached refresh token + state
#   change-email  prompt new email (+ password) and persist to config
#   status        remaining TTL + Deny / limit state
#   claude [args] ensure session + apply model env, emit lightweight OTEL if configured,
#                 then run 'claude'
#   codex [args]  ensure session, then run OpenAI 'codex' against Bedrock
#                 (ADR-014: amazon-bedrock-runtime provider, same credential_process
#                 profile → same IAM / metering / budget deny as claude)
#   setup         point plain 'claude' and 'codex' at Bedrock (no wrapper needed):
#                 ~/.claude/settings.json gets the Bedrock env + awsCredentialExport
#                 (Claude Code runs this script for fresh STS keys), and
#                 ~/.codex/config.toml gets the amazon-bedrock-runtime provider on
#                 the credential_process profile. Re-run after set-model.
#   unsetup       remove what 'setup' wrote (restores direct Anthropic/OpenAI use)
#   set-model K=V (or K V) — update model env in config. Keys (aliases ok):
#                 sonnet | opus | haiku | subagent | pin | codex
#                 (full: ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL,
#                  ANTHROPIC_DEFAULT_HAIKU_MODEL, CLAUDE_CODE_SUBAGENT_MODEL,
#                  ANTHROPIC_MODEL [defaults to opusplan; set a raw model id to
#                  pin /model to "Custom" instead])
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
AWS_CONFIG_FILE="${HOME}/.aws/config"
CLAUDE_SETTINGS_FILE="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/settings.json"
CODEX_CONFIG_FILE="${CODEX_HOME:-${HOME}/.codex}/config.toml"

mkdir -p "${CFG_DIR}" && chmod 700 "${CFG_DIR}" 2>/dev/null || true  # owner-only: refresh token + STS keys

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
OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-${OTEL_COLLECTOR_ENDPOINT:-}}"
OTEL_HELPER="${OTEL_HELPER:-${HOME}/.local/bin/cc-otel-code-metrics}"

# Model env — Bedrock inference profile IDs mapped to Claude Code's model slots.
# Defaults: ANTHROPIC_MODEL=opusplan backs "Default" (Opus for planning, Sonnet for
# execution), Haiku 5.5 backs "Haiku"/background. Set ANTHROPIC_MODEL to a raw model
# id instead to pin /model to "Custom".
# `pin=` writes an empty ANTHROPIC_MODEL= to unset it: only an absent key defaults.
ANTHROPIC_MODEL="${ANTHROPIC_MODEL-opusplan}"
ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-global.anthropic.claude-sonnet-5-5}"
ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-global.anthropic.claude-opus-5-5}"
# ANTHROPIC_SMALL_FAST_MODEL is deprecated; migrate legacy config forward into DEFAULT_HAIKU.
ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-${ANTHROPIC_SMALL_FAST_MODEL:-global.anthropic.claude-haiku-5-5}}"
CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-global.anthropic.claude-sonnet-5-5}"
# Codex CLI model (ADR-014) — must be a cross-Region OpenAI profile (global./us.):
# the bedrock-runtime Responses API rejects foundation-model IDs.
CODEX_MODEL="${CODEX_MODEL:-global.openai.gpt-6.1-sol}"

die() { echo "cc-bedrock-local: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
say() { echo "cc-bedrock-local: $*" >&2; }

otel_prepare() {
  [[ -x "${OTEL_HELPER}" ]] || return 0
  export CC_DEPLOY_MODE=local
  export USER_EMAIL="${EMAIL:-}"
  export CC_DEPARTMENT="${CC_DEPARTMENT:-default}"
  if [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT}" ]]; then
    export OTEL_EXPORTER_OTLP_ENDPOINT
  fi

  mkdir -p "${CFG_DIR}/bin"
  local real_git="/usr/bin/git"
  if [[ ! -x "${real_git}" ]]; then
    real_git="$(PATH="/usr/bin:/bin:/usr/local/bin:${PATH}" command -v git 2>/dev/null || true)"
  fi
  if [[ -n "${real_git}" ]]; then
    "${OTEL_HELPER}" install-git-wrapper "${CFG_DIR}/bin/git" "${real_git}" >/dev/null 2>&1 || true
    export PATH="${CFG_DIR}/bin:${PATH}"
  fi
}

otel_emit() {
  [[ -x "${OTEL_HELPER}" ]] || return 0
  "${OTEL_HELPER}" "$@" >/dev/null 2>&1 || true
}

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

# Absolute path of this script — written into ~/.aws/config as the
# credential_process command, so it must survive cwd changes and bare-name
# invocations from PATH ("cc-bedrock-local"): $0 is then not a path, and
# readlink -f would silently resolve it against $PWD to a non-existent file.
script_abspath() {
  local src="$0"
  if [[ "${src}" != */* ]]; then
    src="$(command -v "${src}" 2>/dev/null || echo "${src}")"
  fi
  if readlink -f "${src}" 2>/dev/null; then return; fi      # GNU
  python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "${src}"  # macOS/BSD
}

# ADR-029: install a credential_process profile instead of static keys.
# - ~/.aws/config [profile X] gets `credential_process = <this script> credential-process`
#   so the AWS SDK re-invokes us whenever cached credentials approach Expiration —
#   true in-session refresh; long claude sessions survive the 1h role-chaining cap.
# - Any stale [X] section in ~/.aws/credentials is REMOVED: entries in the
#   credentials file take precedence over config-file credential_process, so a
#   leftover static-key block from the pre-ADR-029 flow would silently pin the
#   session to expiring keys.
setup_aws_profile() {
  local self created=0
  self="$(script_abspath)"
  mkdir -p "$(dirname "${AWS_CONFIG_FILE}")"
  [[ -f "${AWS_CONFIG_FILE}" ]] || created=1
  touch "${AWS_CONFIG_FILE}"
  python3 - "${AWS_CONFIG_FILE}" "${AWS_PROFILE_NAME}" "${self}" "${AWS_REGION}" <<'PY'
import sys, re, os
path, profile, self_path, region = sys.argv[1:5]
content = open(path).read() if os.path.exists(path) else ""
content = re.sub(rf"\[profile {re.escape(profile)}\].*?(?=^\[|\Z)", "", content, flags=re.M | re.S).rstrip() + "\n"
block = f"\n[profile {profile}]\ncredential_process = {self_path} credential-process\nregion = {region}\n"
open(path, "w").write(content + block)
PY
  # Migration: drop the legacy static-key section (it would shadow credential_process)
  if [[ -f "${AWS_CREDS_FILE}" ]]; then
    python3 - "${AWS_CREDS_FILE}" "${AWS_PROFILE_NAME}" <<'PY'
import sys, re, os
path, profile = sys.argv[1], sys.argv[2]
content = open(path).read()
cleaned = re.sub(rf"\[{re.escape(profile)}\].*?(?=^\[|\Z)", "", content, flags=re.M | re.S).rstrip() + "\n"
if cleaned != content:
    open(path, "w").write(cleaned)
PY
  fi
  # Only tighten permissions on a file WE created — ~/.aws/config is shared
  # with other profiles/tools and is not secret material (unlike credentials).
  if (( created )); then
    chmod 600 "${AWS_CONFIG_FILE}" 2>/dev/null || true
  fi
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
    setup_aws_profile
    save_state "${sts_resp}"
    local exp
    exp="$(echo "${sts_resp}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["credentials"]["expiration"])')"
    echo "✓ credential_process profile=${AWS_PROFILE_NAME} installed, current creds expire=${exp} (SDK auto-renews in-session)"
    sync_codex_mantle
    local note; note="$(mantle_note)"
    [[ -z "${note}" ]] || echo "! ${note}"
  else
    echo "${sts_resp}" >&2
    die "dashboard refused STS issue"
  fi
}

# ─── credential-process (AWS SDK hook, ADR-029) ─────────────
# Contract: print ONE JSON object {"Version":1,...,"Expiration"} on stdout and
# nothing else; all diagnostics go to stderr. The SDK re-invokes this command
# shortly before Expiration, which is what keeps multi-hour sessions alive.
# MUST never prompt (runs headless inside the SDK) — when the Cognito refresh
# token is dead it exits 1 so the SDK surfaces an error telling the user to
# run 'cc-bedrock-local login' (once per ~30 days).
emit_credentials_json() {  # emit_credentials_json <state_file>
  python3 - "$1" <<'PY'
import json, sys
creds = json.load(open(sys.argv[1]))["credentials"]
print(json.dumps({
    "Version": 1,
    "AccessKeyId": creds["accessKeyId"],
    "SecretAccessKey": creds["secretAccessKey"],
    "SessionToken": creds["sessionToken"],
    "Expiration": creds["expiration"],
}))
PY
}

do_credential_process() {
  require_config

  # 1) Cache hit: serve current creds while they have > 5 min left.
  #    (5 min, not 10 — the SDK already refreshes ahead of Expiration; the
  #    margin only guards clock skew between us, AWS, and the SDK.)
  if [[ -f "${STATE_FILE}" ]]; then
    local exp exp_e now_e cached_json
    exp="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["credentials"]["expiration"])' "${STATE_FILE}" 2>/dev/null || true)"
    if [[ -n "${exp}" ]]; then
      exp_e="$(iso_to_epoch "${exp}")"; now_e="$(epoch_now)"
      if (( exp_e - now_e > 300 )); then
        # Buffer before printing so a corrupt state.json falls through to a
        # fresh re-issue instead of dying mid-emit (stdout must stay clean).
        if cached_json="$(emit_credentials_json "${STATE_FILE}" 2>/dev/null)"; then
          echo "${cached_json}"
          return 0
        fi
        say "state.json unreadable — re-issuing credentials"
      fi
    fi
  fi

  # 2) Silent re-issue: Cognito refresh token → access token → STS exchange.
  [[ -f "${TOKEN_CACHE}" ]] || { say "no cached session — run 'cc-bedrock-local login'"; return 1; }
  local refresh_token access_token resp sts_resp
  refresh_token=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("refreshToken","") or "")' "${TOKEN_CACHE}" 2>/dev/null || true)
  [[ -n "${refresh_token}" ]] || { say "no refresh token cached — run 'cc-bedrock-local login'"; return 1; }

  resp=$(cognito_refresh_request "${refresh_token}")
  access_token=$(echo "${resp}" | parse_cognito_token "AccessToken" 2>/dev/null || echo "")
  if [[ -z "${access_token}" ]]; then
    say "Cognito refresh token expired (30-day window) — run 'cc-bedrock-local login'"
    return 1
  fi
  cache_tokens "${access_token}" "${refresh_token}"

  sts_resp=$(sts_exchange "${access_token}")
  if ! echo "${sts_resp}" | python3 -c 'import json,sys; sys.exit(0 if "credentials" in json.loads(sys.stdin.read()) else 1)' 2>/dev/null; then
    echo "${sts_resp}" >&2
    say "dashboard refused STS issue (token limit Deny active? check 'cc-bedrock-local status')"
    return 1
  fi
  save_state "${sts_resp}"
  sync_codex_mantle >&2
  emit_credentials_json "${STATE_FILE}"
}

# ─── logout (clear cache + state) ───────────────────────────
do_logout() {
  rm -f "${TOKEN_CACHE}" "${STATE_FILE}"
  echo "✓ cached session cleared (run 'cc-bedrock-local login' to sign in again)"
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
  # ADR-029: idempotent — make sure the credential_process profile exists even
  # when the cached state was still fresh (migration from the static-key flow).
  setup_aws_profile

  CLAUDE_CODE_USE_BEDROCK=1 \
    AWS_PROFILE="${AWS_PROFILE_NAME}" \
    AWS_REGION="${AWS_REGION}" \
    exec "${args[@]}"
}

# ─── codex (ensure session + exec codex on Bedrock, ADR-014) ─
do_codex() {
  have codex || die "codex CLI not found — install: npm install -g @openai/codex@0.163.0"
  # Provider + region are pinned as session overrides (highest user-reachable
  # layer) so a personal ~/.codex/config.toml pointing at api.openai.com cannot
  # silently route around Bedrock governance. Model only when the user didn't
  # pick one (-m/--model or -c model=...).
  local model_set=0 a
  for a in "$@"; do
    case "${a}" in -m|--model|--model=*|model=*) model_set=1 ;; esac
  done
  local overrides=(
    -c 'model_provider="amazon-bedrock-runtime"'
    -c "model_providers.amazon-bedrock-runtime.aws.region=\"${AWS_REGION}\""
    -c 'web_search="disabled"'
  )
  (( model_set )) || overrides+=(-c "model=\"${CODEX_MODEL}\"")
  do_run -- codex "${overrides[@]}" "$@"
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
  # ADR-029: idempotent — make sure the credential_process profile exists even
  # when the cached state was still fresh (migration from the static-key flow).
  setup_aws_profile

  if [[ -n "${ANTHROPIC_MODEL}" && "${ANTHROPIC_MODEL}" != "opusplan" ]]; then
    echo "[Bedrock] pinned=${ANTHROPIC_MODEL} (forces /model Custom slot)"
  else
    echo "[Bedrock] sonnet=${ANTHROPIC_DEFAULT_SONNET_MODEL} opus=${ANTHROPIC_DEFAULT_OPUS_MODEL} haiku=${ANTHROPIC_DEFAULT_HAIKU_MODEL}"
  fi

  export CLAUDE_CODE_USE_BEDROCK=1
  export AWS_PROFILE="${AWS_PROFILE_NAME}"
  export AWS_REGION="${AWS_REGION}"
  export ANTHROPIC_DEFAULT_SONNET_MODEL
  export ANTHROPIC_DEFAULT_OPUS_MODEL
  export ANTHROPIC_DEFAULT_HAIKU_MODEL
  export CLAUDE_CODE_SUBAGENT_MODEL
  otel_prepare
  # Export ANTHROPIC_MODEL whenever set (default: opusplan); unset it entirely
  # only if the user cleared it, so the picker falls back to raw Sonnet "Default".
  if [[ -n "${ANTHROPIC_MODEL}" ]]; then
    export ANTHROPIC_MODEL
  else
    unset ANTHROPIC_MODEL
  fi
  # Don't leak the deprecated var to claude (DEFAULT_HAIKU is the canonical knob).
  unset ANTHROPIC_SMALL_FAST_MODEL

  local start_e hb_pid="" status duration
  start_e="$(epoch_now)"
  otel_emit session-start

  # Heartbeat as a detached background child. Started BEFORE claude so claude can
  # run in the FOREGROUND and keep the TTY/stdin — backgrounding the interactive
  # TUI (claude … &) routes its stdin to /dev/null in this non-job-control shell
  # and breaks key input (the headline regression). The trap cleans the heartbeat
  # up on normal exit AND on Ctrl-C/term so it can't orphan.
  hb_cleanup() {
    [[ -n "${hb_pid}" ]] && kill "${hb_pid}" 2>/dev/null || true
    hb_pid=""
  }
  if [[ -x "${OTEL_HELPER}" ]]; then
    (
      while sleep 300; do
        "${OTEL_HELPER}" heartbeat --force >/dev/null 2>&1 || true
      done
    ) &
    hb_pid=$!
  fi
  trap hb_cleanup EXIT INT TERM

  # Foreground: claude owns the controlling TTY and reads real stdin.
  set +e
  claude --dangerously-skip-permissions "$@"
  status=$?
  set -e

  hb_cleanup
  trap - EXIT INT TERM
  duration=$(( $(epoch_now) - start_e ))
  otel_emit session-end "${duration}"
  exit "${status}"
}

# ─── setup / unsetup (native claude + codex, no wrapper) ────
# Claude Code: the env block makes plain 'claude' use Bedrock with the configured
# models, and awsCredentialExport makes it run 'credential-process' for keys at
# session start and whenever they near expiry. Those keys stay inside Claude
# Code's Bedrock client; the commands Claude runs keep the user's own AWS chain.
# Codex: amazon-bedrock-runtime provider on the credential_process profile, so
# plain 'codex' signs with the same per-user role (ADR-014 metering + deny).
# Every key written here is removed again by 'unsetup'; the first edit of each
# file keeps a one-time backup next to it (*.cc-bedrock.bak).
CLAUDE_MANAGED_ENV=(CLAUDE_CODE_USE_BEDROCK AWS_REGION ANTHROPIC_MODEL
  ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL
  ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL)
CODEX_MARK="# managed by cc-bedrock-local"

backup_once() {  # backup_once <file>
  [[ -f "$1" && ! -e "$1.cc-bedrock.bak" ]] && cp -p "$1" "$1.cc-bedrock.bak" || true
}

configure_claude() {  # configure_claude <credential-export command>
  mkdir -p "$(dirname "${CLAUDE_SETTINGS_FILE}")"
  backup_once "${CLAUDE_SETTINGS_FILE}"
  python3 - "${CLAUDE_SETTINGS_FILE}" "$1" "${CLAUDE_MANAGED_ENV[@]}" <<'PY'
import json, os, sys
path, export_cmd, keys = sys.argv[1], sys.argv[2], sys.argv[3:]
CRED_RULE = "Read(~/.config/cc-bedrock/**)"
try:
    settings = json.load(open(path, encoding="utf-8-sig")) if os.path.exists(path) and os.path.getsize(path) else {}
except ValueError as e:
    sys.exit(f"cc-bedrock-local: {path} is not valid JSON ({e}); fix it and re-run 'setup'")
env = settings.setdefault("env", {})
for k in keys:
    v = os.environ.get(k, "")
    if v:
        env[k] = v
    else:
        env.pop(k, None)
settings["awsCredentialExport"] = export_cmd
# Claude's Read tool must not open the cached refresh token / STS keys.
deny = settings.setdefault("permissions", {}).setdefault("deny", [])
if CRED_RULE not in deny:
    deny.append(CRED_RULE)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

# Strip what 'setup' manages (and any unmarked duplicates of those keys, which
# would make the TOML invalid once ours are added), then optionally add ours.
configure_codex() {  # configure_codex add|remove
  [[ "$1" == add || -f "${CODEX_CONFIG_FILE}" ]] || return 0
  mkdir -p "$(dirname "${CODEX_CONFIG_FILE}")"
  backup_once "${CODEX_CONFIG_FILE}"
  python3 - "${CODEX_CONFIG_FILE}" "$1" "${CODEX_MARK}" "${CODEX_MODEL}" "${AWS_PROFILE_NAME}" "${AWS_REGION}" "${CFG_DIR}" "${STATE_FILE}" "${CC_BEDROCK_QUIET:-}" <<'PY'
import json, os, re, sys
path, mode, mark, model, profile, region, cfg_dir, state_file, quiet = sys.argv[1:10]
lines = open(path, encoding="utf-8-sig").read().splitlines() if os.path.exists(path) else []
TABLE = "[model_providers.amazon-bedrock-runtime.aws]"
PERMS = "[permissions.cc-bedrock]"
PERMS_FS = "[permissions.cc-bedrock.filesystem]"
# ADR-014 §9 (amended 2026-11-03): while the dashboard reports a mantle grant
# (unlimited-cost users; NOT metered) bedrock-mantle is the DEFAULT provider in
# config.toml, so plain `codex` and the Codex app get web search; the metered
# runtime path stays available as `codex -p runtime`, and `codex -p mantle` keeps
# working. Without a grant, runtime is the default as before. Codex loads
# `-p <name>` from <CODEX_HOME>/<name>.config.toml and rejects a
# [profiles.<name>] table in config.toml, so each profile is its own file.
M_PROFILE = "[profiles.mantle]"  # stripped only (never written)
M_AWS = "[model_providers.amazon-bedrock.aws]"
M_HDR = "[model_providers.amazon-bedrock.http_headers]"
m_path = os.path.join(os.path.dirname(path), "mantle.config.toml")
r_path = os.path.join(os.path.dirname(path), "runtime.config.toml")
try:
    mantle = json.load(open(state_file)).get("mantle") or {}
except Exception:
    mantle = {}
m_ours = not os.path.exists(m_path) or mark in open(m_path).read()
r_ours = not os.path.exists(r_path) or mark in open(r_path).read()
want_mantle = mode == "add" and mantle.get("enabled") and mantle.get("projectId")
# Ownership of the amazon-bedrock provider is decided for the provider as a whole.
# Marked tables are ours. Unmarked ones are the user's and are never touched, except
# while a grant is present and every unmarked amazon-bedrock table is the aws or
# headers table holding only keys we manage (aws: profile/region; headers:
# OpenAI-Project) - e.g. a leftover `region = "us-east-1"` from a manual mantle
# setup - then they are replaced. Otherwise the user's provider stays whole and
# mantle is not made the default (a second table would be invalid TOML).
hdr = lambda l: l.split("#", 1)[0].strip()
M_KEYS = {M_AWS: {"profile", "region"}, M_HDR: {"OpenAI-Project"}}
is_m = lambda h: h == "[model_providers.amazon-bedrock]" or h.startswith("[model_providers.amazon-bedrock.")
def managed_keys_only(i):
    keys = M_KEYS.get(hdr(lines[i]))
    if keys is None:
        return False
    for l in lines[i + 1:]:
        if l.strip().startswith("["):
            break
        k = hdr(l).split("=", 1)[0].strip().strip('"')
        if k and k not in keys:
            return False
    return True
m_marked = {i for i, l in enumerate(lines) if is_m(hdr(l)) and mark in l}
m_unmarked = {i for i, l in enumerate(lines) if is_m(hdr(l)) and mark not in l}
replace_unmarked = bool(want_mantle) and all(managed_keys_only(i) for i in m_unmarked)
m_ours_at = m_marked | (m_unmarked if replace_unmarked else set())
own_m = bool(m_unmarked) and not replace_unmarked
default_mantle = want_mantle and not own_m
if want_mantle and own_m and not quiet:
    sys.stderr.write("cc-bedrock-local: ~/.codex/config.toml has its own [model_providers.amazon-bedrock.*]; "
                     "codex stays on bedrock-runtime by default (mantle: codex -p mantle)\n")
top_key = re.compile(r"^\s*(model_provider|model|web_search)\s*=")
out, in_top, in_ours = [], True, False
for idx, line in enumerate(lines):
    if line.strip().startswith("["):
        in_top = False
        in_ours = hdr(line) in (TABLE, PERMS, PERMS_FS, M_PROFILE) or idx in m_ours_at
        if in_ours:
            continue
    if in_ours or mark in line or (in_top and top_key.match(line)):
        continue
    out.append(line)
# Drop the blank lines our removals leave behind (edges + doubled gaps).
out = [l for i, l in enumerate(out) if l.strip() or (i and out[i - 1].strip())]
while out and not out[0].strip():
    out.pop(0)
while out and not out[-1].strip():
    out.pop()
q = lambda v: '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
m_model = mantle.get("model") or "openai.gpt-6.1-sol"
m_region = mantle.get("region") or "us-east-1"
# The mantle provider tables (profile, region, and the OpenAI-Project header: IAM
# allows only the user's own project, so without it the call lands in
# project/default and is denied).
m_tables = ["", f"{M_AWS}  {mark}", f"profile = {q(profile)}", f"region = {q(m_region)}",
            "", f"{M_HDR}  {mark}", f"OpenAI-Project = {q(mantle.get('projectId') or '')}"]
if mode == "add":
    if default_mantle:
        head = [f'model_provider = "amazon-bedrock"  {mark}',
                f"model = {q(m_model)}  {mark}",
                f'web_search = "live"  {mark}']
    else:
        head = [f'model_provider = "amazon-bedrock-runtime"  {mark}',
                f"model = {q(model)}  {mark}",
                f'web_search = "disabled"  {mark}']
    tail = ["", f"{TABLE}  {mark}", f"profile = {q(profile)}", f"region = {q(region)}"]
    if default_mantle:
        tail += m_tables
    # Keep commands Codex runs away from the cached refresh token and STS keys:
    # a permission profile on top of :workspace that denies the CLI's directory
    # (enforced by the sandbox; Codex's own credential_process call is not
    # sandboxed). Profiles and sandbox_mode don't compose, so a user who already
    # chose a sandbox keeps it and gets a warning instead.
    own = [l for l in out if re.match(r"^\s*(default_permissions|sandbox_mode)\s*=", l)
           or l.split("#", 1)[0].strip() == "[sandbox_workspace_write]"]
    if own:
        if not quiet:
            sys.stderr.write("cc-bedrock-local: ~/.codex/config.toml sets its own sandbox; "
                             f"add a read deny for {cfg_dir} yourself (see Codex permissions docs)\n")
    else:
        head.append(f'default_permissions = "cc-bedrock"  {mark}')
        tail += ["", f"{PERMS}  {mark}", 'extends = ":workspace"',
                 "", f"{PERMS_FS}  {mark}", f'{q(cfg_dir)} = "deny"']
    out = head + ([""] + out if out else []) + tail
def write_profile(p, body):
    p_tmp = f"{p}.{os.getpid()}.tmp"
    with open(p_tmp, "w") as f:
        f.write("\n".join(body) + "\n")
    os.replace(p_tmp, p)
if want_mantle and m_ours:
    write_profile(m_path, [
        f"{mark} — bedrock-mantle (web search). NOT counted in usage or budget;",
        "# granted only while your cost is unlimited. Use: codex -p mantle",
        'model_provider = "amazon-bedrock"', f"model = {q(m_model)}", 'web_search = "live"',
        *[l.replace(f"  {mark}", "") for l in m_tables]])
elif want_mantle and not quiet:
    sys.stderr.write(f"cc-bedrock-local: {m_path} is your own file — not adding the mantle profile\n")
elif m_ours and os.path.exists(m_path):
    os.remove(m_path)
if default_mantle and r_ours:
    write_profile(r_path, [
        f"{mark} — bedrock-runtime (metered: counted in usage and budget, no web search).",
        "# Use: codex -p runtime",
        'model_provider = "amazon-bedrock-runtime"', f"model = {q(model)}", 'web_search = "disabled"'])
elif default_mantle and not quiet:
    sys.stderr.write(f"cc-bedrock-local: {r_path} is your own file — not adding the runtime profile\n")
elif r_ours and os.path.exists(r_path):
    os.remove(r_path)
# Unique tmp: credential-process (claude + codex) may refresh concurrently.
tmp = f"{path}.{os.getpid()}.tmp"
with open(tmp, "w") as f:
    f.write("\n".join(out) + ("\n" if out else ""))
os.replace(tmp, path)
PY
}

# "<provider> <model>" that config.toml actually defaults to (our managed keys;
# empty before setup), so messages report what was applied, not what was granted.
codex_default() {
  [[ -f "${CODEX_CONFIG_FILE}" ]] || return 0
  sed -nE 's/^(model_provider|model) = "([^"]*)"  # managed by cc-bedrock-local$/\2/p' "${CODEX_CONFIG_FILE}" | paste -sd' ' -
}

mantle_note() {  # one line describing the mantle grant in state.json (empty when none)
  [[ -f "${STATE_FILE}" ]] || return 0
  python3 - "${STATE_FILE}" "$(codex_default)" <<'PY' 2>/dev/null || true
import json, sys
m = json.load(open(sys.argv[1])).get("mantle") or {}
if m.get("enabled"):
    if sys.argv[2].split(" ")[0] == "amazon-bedrock":
        print(f"mantle ({m.get('model')}, {m.get('region')}): DEFAULT for codex + the Codex app — web search; "
              "NOT counted in usage or budget; metered runtime: codex -p runtime; available while your cost is unlimited")
    else:
        print(f"mantle ({m.get('model')}, {m.get('region')}): codex -p mantle — web search; NOT counted in usage or budget; "
              "not the codex default (config.toml has its own amazon-bedrock provider, or setup has not run); "
              "available while your cost is unlimited")
PY
}

# After new credentials: keep the Codex mantle profile in step with the grant
# (it appears/disappears as an admin removes/sets cost caps). Gated on our own
# Codex keys, not on Claude's settings, so a revocation always reverts Codex.
# Files + stderr only.
sync_codex_mantle() {
  codex_configured || return 0
  CC_BEDROCK_QUIET=1 configure_codex add || say "could not update ${CODEX_CONFIG_FILE}"
}

codex_configured() {
  [[ -f "${CODEX_CONFIG_FILE}" ]] && grep -qF "${CODEX_MARK}" "${CODEX_CONFIG_FILE}"
}

clients_configured() {
  [[ -f "${CLAUDE_SETTINGS_FILE}" ]] && python3 - "${CLAUDE_SETTINGS_FILE}" <<'PY' 2>/dev/null
import json, sys
sys.exit(0 if str(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("awsCredentialExport", "")).endswith(" credential-process") else 1)
PY
}

do_setup() {
  require_config
  setup_aws_profile
  local self
  self="$(script_abspath)"
  CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION="${AWS_REGION}" ANTHROPIC_MODEL="${ANTHROPIC_MODEL}" \
    ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL}" \
    ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL}" \
    ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL}" \
    CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL}" \
    configure_claude "$(printf '%q' "${self}") credential-process"
  configure_codex add
  echo "✓ claude → Bedrock (${CLAUDE_SETTINGS_FILE}: env + awsCredentialExport)"
  local applied; applied="$(codex_default)"
  echo "✓ codex  → Bedrock (${CODEX_CONFIG_FILE}: ${applied%% *}, profile=${AWS_PROFILE_NAME}, model=${applied#* })"
  local note; note="$(mantle_note)"
  [[ -z "${note}" ]] || echo "! ${note}"
  # A Bedrock API key outranks the profile in both tools and would bypass the
  # per-user role (metering, budget deny).
  [[ -z "${AWS_BEARER_TOKEN_BEDROCK:-}" ]] ||
    say "AWS_BEARER_TOKEN_BEDROCK is set — claude/codex would use that key instead of your cc-bedrock role; unset it (shell rc too)"
  have claude || say "claude not found — install: npm install -g @anthropic-ai/claude-code"
  have codex  || say "codex not found — install: npm install -g @openai/codex@0.163.0"
}

do_unsetup() {
  if [[ -f "${CLAUDE_SETTINGS_FILE}" ]]; then
    python3 - "${CLAUDE_SETTINGS_FILE}" "${CLAUDE_MANAGED_ENV[@]}" <<'PY'
import json, os, sys
path, keys = sys.argv[1], sys.argv[2:]
settings = json.load(open(path, encoding="utf-8-sig"))
env = settings.get("env", {})
for k in keys:
    env.pop(k, None)
if not env:
    settings.pop("env", None)
if str(settings.get("awsCredentialExport", "")).endswith(" credential-process"):
    settings.pop("awsCredentialExport")
perms = settings.get("permissions", {})
if "Read(~/.config/cc-bedrock/**)" in perms.get("deny", []):
    perms["deny"].remove("Read(~/.config/cc-bedrock/**)")
    if not perms["deny"]:
        perms.pop("deny")
    if not perms:
        settings.pop("permissions")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
  fi
  configure_codex remove
  echo "✓ removed Bedrock settings from ${CLAUDE_SETTINGS_FILE} and ${CODEX_CONFIG_FILE}"
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
    sonnet|default|ANTHROPIC_DEFAULT_SONNET_MODEL)       key="ANTHROPIC_DEFAULT_SONNET_MODEL" ;;
    opus|ANTHROPIC_DEFAULT_OPUS_MODEL)                   key="ANTHROPIC_DEFAULT_OPUS_MODEL" ;;
    haiku|fast|small|ANTHROPIC_DEFAULT_HAIKU_MODEL|ANTHROPIC_SMALL_FAST_MODEL)
                                                         key="ANTHROPIC_DEFAULT_HAIKU_MODEL" ;;
    subagent|CLAUDE_CODE_SUBAGENT_MODEL)                 key="CLAUDE_CODE_SUBAGENT_MODEL" ;;
    pin|model|ANTHROPIC_MODEL)                           key="ANTHROPIC_MODEL" ;;
    codex|gpt|CODEX_MODEL)                               key="CODEX_MODEL" ;;
    *) die "unknown model key: ${key} (use sonnet|opus|haiku|subagent|pin|codex)" ;;
  esac
  config_set "${key}" "${val}"
  echo "✓ ${key}=${val} (saved to ${CFG_FILE})"
  if clients_configured; then
    printf -v "${key}" '%s' "${val}"
    do_setup >/dev/null
    echo "✓ claude/codex settings updated"
    # With a mantle grant the default codex model comes from the grant (mantle IDs
    # differ from bedrock-runtime ones); CODEX_MODEL drives the metered runtime path.
    if [[ "${key}" == CODEX_MODEL && "$(codex_default)" == amazon-bedrock\ * ]]; then
      echo "  codex default is mantle ($(codex_default | cut -d' ' -f2-), from your grant); CODEX_MODEL applies to codex -p runtime"
    fi
  fi
}

# ─── models (display) ───────────────────────────────────────
do_models() {
  cat <<EOF
Current model env (from ${CFG_FILE} or defaults):
  ANTHROPIC_DEFAULT_SONNET_MODEL = ${ANTHROPIC_DEFAULT_SONNET_MODEL}   # /model Default + Sonnet
  ANTHROPIC_DEFAULT_OPUS_MODEL   = ${ANTHROPIC_DEFAULT_OPUS_MODEL}   # /model Opus
  ANTHROPIC_DEFAULT_HAIKU_MODEL  = ${ANTHROPIC_DEFAULT_HAIKU_MODEL}   # /model Haiku + background
  CLAUDE_CODE_SUBAGENT_MODEL     = ${CLAUDE_CODE_SUBAGENT_MODEL}   # subagent dispatch
  ANTHROPIC_MODEL                = ${ANTHROPIC_MODEL:-(unset — picker shows Default)}
  CODEX_MODEL                    = ${CODEX_MODEL}   # codex (OpenAI on Bedrock)

Examples:
  cc-bedrock-local set-model sonnet 'global.anthropic.claude-sonnet-5-5'
  cc-bedrock-local set-model opus   'global.anthropic.claude-opus-5-5'
  cc-bedrock-local set-model haiku  global.anthropic.claude-haiku-5-5
  cc-bedrock-local set-model pin    global.anthropic.claude-opus-5-5   # force Custom slot
  cc-bedrock-local set-model codex  global.openai.gpt-6.1-sol          # codex default
  cc-bedrock-local set-model codex  global.openai.gpt-6-luna           # cheaper codex

Aliases: sonnet|default | opus | haiku|fast|small | subagent | pin|model | codex|gpt
EOF
}

do_status() {
  if [[ ! -f "${STATE_FILE}" ]]; then
    echo "no session — run 'cc-bedrock-local login'"
    return 1
  fi
  python3 - "${STATE_FILE}" "${TOKEN_CACHE}" "${EMAIL:-}" "$(codex_default)" <<'PY'
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
mantle = state.get("mantle") or {}
if mantle.get("enabled"):
    where = ("codex default (runtime: codex -p runtime" if sys.argv[4].split(" ")[0] == "amazon-bedrock"
             else "codex -p mantle only (codex default stays bedrock-runtime")
    print(f"mantle        : enabled, {where}; {mantle.get('model')}, {mantle.get('region')}, "
          f"project {mantle.get('projectId')}) — NOT counted in usage or budget")
else:
    print("mantle        : off (available only while your cost is unlimited)")
if limit.get("denyActive"):
    print(f"  reason      : {limit.get('denyReason')}")
    print(f"  reset_at    : {limit.get('resetAt')}")
if os.path.exists(sys.argv[2]):
    tk = json.load(open(sys.argv[2]))
    age = int(datetime.datetime.now(datetime.timezone.utc).timestamp() - tk.get("obtainedAt", 0))
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
OTEL endpoint      : ${OTEL_EXPORTER_OTLP_ENDPOINT:-(unset)}
EOF
}

do_usage() {
  cat <<EOF
cc-bedrock-local — Local Governance Mode CLI (ADR-006 (legacy ADR-014))

Subcommands:
  login                       prompt password (email from config) → login + STS issue
  refresh                     silent only — uses cached refresh token
  credential-process          AWS SDK credential_process hook (auto-wired into
                              ~/.aws/config at login; renews mid-session — ADR-029)
  logout                      clear cached session
  change-email                prompt new email + password, update config, re-login
  status                      session state + limit/deny state
  claude [args]               ensure session + apply model env from config, exec claude
                              emits lightweight OTEL session/git metrics when configured
  codex [args]                ensure session, exec OpenAI codex on Bedrock (ADR-014)
  setup                       configure plain 'claude' + 'codex' for Bedrock
                              (~/.claude/settings.json, ~/.codex/config.toml);
                              unlimited-cost users get bedrock-mantle as the
                              codex default (web search — NOT metered);
                              metered runtime: 'codex -p runtime'
  unsetup                     remove those settings again
  set-model KEY=VAL           change model env in config (alias keys: sonnet|opus|haiku|subagent|pin|codex)
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
  credential-process|credential_process) do_credential_process ;;
  logout)       do_logout ;;
  change-email|change_email) do_change_email ;;
  status)       do_status "$@" ;;
  run)          do_run "$@" ;;
  claude)       do_claude "$@" ;;
  codex)        do_codex "$@" ;;
  setup)        do_setup ;;
  unsetup)      do_unsetup ;;
  set-model|set_model) do_set_model "$@" ;;
  models)       do_models ;;
  config)       do_config ;;
  ""|-h|--help|help) do_usage ;;
  *) die "unknown subcommand: ${sub}" ;;
esac
