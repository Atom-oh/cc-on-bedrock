#!/usr/bin/env bash
# cc-bedrock-local setup/unsetup: writes ~/.claude/settings.json and
# ~/.codex/config.toml so plain `claude` / `codex` use Bedrock, keeps the user's
# own keys, is idempotent, follows set-model, and unsetup removes only its keys.
# Runs in a throwaway HOME with a clean env (no network, no AWS calls).
set -euo pipefail
cd "$(dirname "$0")/../.."

_t="${TMPDIR:-/tmp}"; TMP="$(mktemp -d "${_t%/}/ccbl-setup.XXXXXX")"  # macOS TMPDIR ends in /
trap 'rm -rf "${TMP}"' EXIT
H="${TMP}/home"
CLI="${TMP}/bin/cc-bedrock-local"
mkdir -p "${H}/.config/cc-bedrock" "${H}/.claude" "${H}/.codex" "${TMP}/bin"
cp tools/cc-bedrock-local.sh "${CLI}"
chmod +x "${CLI}"

cat > "${H}/.config/cc-bedrock/config" <<'EOF'
DASHBOARD_URL=https://dashboard.example.invalid
COGNITO_CLIENT_ID=client
EMAIL=user@example.com
CODEX_MODEL=global.openai.gpt-6.1-sol
EOF
echo '{"permissions":{"allow":["Bash(ls)"]},"env":{"FOO":"1"}}' > "${H}/.claude/settings.json"
cat > "${H}/.codex/config.toml" <<'EOF'
model = "gpt-5"
approval_policy = "never"

[profiles.work]
model = "o3"

[model_providers.amazon-bedrock-runtime.aws]
region = "us-east-1"
EOF

run() { env -i HOME="${H}" PATH="/usr/bin:/bin" "${CLI}" "$@" >/dev/null 2>>"${TMP}/stderr.log"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# json <expr>: evaluates a test-authored Python expression over settings.json (d).
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "${H}/.claude/settings.json" "$1"; }
count() { grep -cE "$1" "${H}/.codex/config.toml" || true; }

run setup
[[ "$(json 'd["env"]["CLAUDE_CODE_USE_BEDROCK"]')" == 1 ]] || fail "CLAUDE_CODE_USE_BEDROCK not set"
[[ "$(json 'd["env"]["ANTHROPIC_MODEL"]')" == opusplan ]] || fail "ANTHROPIC_MODEL default"
[[ "$(json 'd["env"]["FOO"]')" == 1 ]] || fail "user env key lost"
[[ "$(json 'd["permissions"]["allow"][0]')" == "Bash(ls)" ]] || fail "user settings lost"
[[ "$(json 'd["awsCredentialExport"]')" == "${CLI} credential-process" ]] || fail "awsCredentialExport"
[[ "$(json '"AWS_PROFILE" in d["env"]')" == False ]] || fail "AWS_PROFILE must not leak into Claude's subprocesses"
[[ "$(json 'd["permissions"]["deny"]')" == "['Read(~/.config/cc-bedrock/**)']" ]] || fail "claude read deny on credential cache"

[[ "$(count '^model_provider = "amazon-bedrock-runtime"')" == 1 ]] || fail "model_provider"
top_models="$(awk '/^\[/{exit} /^model = /{n++} END{print n+0}' "${H}/.codex/config.toml")"
[[ "${top_models}" == 1 ]] || fail "duplicate top-level model (invalid TOML)"
[[ "$(count '^model = "global.openai.gpt-6.1-sol"')" == 1 ]] || fail "codex model"
[[ "$(count '^\[model_providers\.amazon-bedrock-runtime\.aws\]')" == 1 ]] || fail "duplicate provider table"
[[ "$(count '^profile = "cc-bedrock"')" == 1 ]] || fail "codex aws profile"
[[ "$(count '^region = "ap-northeast-2"')" == 1 ]] || fail "codex aws region"
[[ "$(count '^region = "us-east-1"')" == 0 ]] || fail "stale provider table kept"
[[ "$(count '^approval_policy = "never"')" == 1 ]] || fail "user codex key lost"
[[ "$(count '^model = "o3"')" == 1 ]] || fail "user profile table lost"
# Top-level keys must precede the first table, or TOML scopes them to that table.
first_table="$(grep -nE '^\[' "${H}/.codex/config.toml" | head -1 | cut -d: -f1)"
mp_line="$(grep -nE '^model_provider' "${H}/.codex/config.toml" | cut -d: -f1)"
(( mp_line < first_table )) || fail "model_provider not at top level"
grep -q '^credential_process = .* credential-process$' "${H}/.aws/config" || fail "credential_process profile"
[[ "$(count '^default_permissions = "cc-bedrock"')" == 1 ]] || fail "codex default permission profile"
grep -qxF "\"${H}/.config/cc-bedrock\" = \"deny\"" "${H}/.codex/config.toml" || fail "codex read deny on credential cache"
grep -qxF 'extends = ":workspace"' "${H}/.codex/config.toml" || fail "codex profile must extend :workspace"
[[ -f "${H}/.claude/settings.json.cc-bedrock.bak" && -f "${H}/.codex/config.toml.cc-bedrock.bak" ]] || fail "backups"

# One subcommand serves both ~/.aws/config credential_process and Claude Code's
# awsCredentialExport: the flat credential_process JSON, which Claude Code accepts
# too. Served from a valid cached state (no network).
exp="$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) + d.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"  # portable (no GNU date -d on macOS)
echo "{\"credentials\":{\"accessKeyId\":\"AKIDTEST\",\"secretAccessKey\":\"s\",\"sessionToken\":\"t\",\"expiration\":\"${exp}\"}}" \
  > "${H}/.config/cc-bedrock/state.json"
cred="$(env -i HOME="${H}" PATH="/usr/bin:/bin" "${CLI}" credential-process 2>/dev/null)"
python3 -c "
import json, sys
d = json.loads(sys.argv[1])
assert d['Version'] == 1 and d['AccessKeyId'] == 'AKIDTEST' and d['SessionToken'] == 't' and d['Expiration'], d
" "${cred}" || fail "credential-process must print the flat credential_process JSON (also read by awsCredentialExport)"
rm -f "${H}/.config/cc-bedrock/state.json"

snap_c="$(cat "${H}/.codex/config.toml")"; snap_s="$(cat "${H}/.claude/settings.json")"
run setup
[[ "$(cat "${H}/.codex/config.toml")" == "${snap_c}" ]] || fail "codex config not idempotent"
[[ "$(cat "${H}/.claude/settings.json")" == "${snap_s}" ]] || fail "claude settings not idempotent"

run set-model codex global.openai.gpt-6-luna
[[ "$(count '^model = "global.openai.gpt-6-luna"')" == 1 ]] || fail "set-model codex not applied"
run set-model opus global.anthropic.claude-opus-5-5
[[ "$(json 'd["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"]')" == global.anthropic.claude-opus-5-5 ]] || fail "set-model opus"
run set-model pin=
[[ "$(json '"ANTHROPIC_MODEL" in d["env"]')" == False ]] || fail "empty pin should unset ANTHROPIC_MODEL"
# The unset must survive a new process (setup / credential sync re-reads the config).
run setup
[[ "$(json '"ANTHROPIC_MODEL" in d["env"]')" == False ]] || fail "pin= did not persist across a re-run"

run unsetup
[[ "$(json 'd["env"]')" == "{'FOO': '1'}" ]] || fail "unsetup left managed env keys"
[[ "$(json '"awsCredentialExport" in d')" == False ]] || fail "unsetup left awsCredentialExport"
[[ "$(count 'managed by cc-bedrock-local|amazon-bedrock-runtime|^profile = ')" == 0 ]] || fail "unsetup left codex keys"
[[ "$(count '^approval_policy = "never"')" == 1 ]] || fail "unsetup dropped user codex key"
[[ "$(json '"deny" in d["permissions"]')" == False ]] || fail "unsetup left the claude read deny"
[[ "$(count 'permissions|deny')" == 0 ]] || fail "unsetup left the codex permission profile"

# Mantle (ADR-014 §9, amended 2026-11-03): while state.json reports a grant,
# bedrock-mantle is the config.toml default (plain codex + Codex app get web search),
# the metered runtime path is runtime.config.toml (`codex -p runtime`), and
# mantle.config.toml (`codex -p mantle`) stays. Profiles are their own files
# (Codex rejects [profiles.x] in config.toml). No grant: runtime is the default.
M="${H}/.codex/mantle.config.toml"
R="${H}/.codex/runtime.config.toml"
mc() { grep -cE "$1" "${M}" || true; }
rc() { grep -cE "$1" "${R}" || true; }
run setup
[[ ! -e "${M}" ]] || fail "mantle profile without a grant"
[[ ! -e "${R}" ]] || fail "runtime profile without a grant"
[[ "$(count '^model_provider = "amazon-bedrock-runtime"')" == 1 ]] || fail "runtime must be the default without a grant"
echo '{"credentials":{},"mantle":{"enabled":true,"projectId":"proj_abc","region":"us-east-1","model":"openai.gpt-6.1-sol"}}' \
  > "${H}/.config/cc-bedrock/state.json"
run setup
[[ -f "${M}" ]] || fail "mantle profile missing"
[[ "$(mc '^model_provider = "amazon-bedrock"$')" == 1 ]] || fail "mantle provider"
[[ "$(mc '^web_search = "live"$')" == 1 ]] || fail "mantle web search"
[[ "$(mc '^OpenAI-Project = "proj_abc"$')" == 1 ]] || fail "mantle project header"
[[ "$(mc '^region = "us-east-1"$')" == 1 ]] || fail "mantle region"
[[ "$(mc 'NOT counted in usage or budget')" == 1 ]] || fail "mantle file must say it is not metered"
[[ "$(count 'profiles\.mantle')" == 0 ]] || fail "[profiles.mantle] in config.toml"
[[ "$(count '^model_provider = "amazon-bedrock"  # managed by cc-bedrock-local$')" == 1 ]] || fail "mantle must be the default with a grant"
[[ "$(count '^web_search = "live"  # managed by cc-bedrock-local$')" == 1 ]] || fail "default web search"
[[ "$(count '^\[model_providers\.amazon-bedrock\.aws\]  # managed by cc-bedrock-local$')" == 1 ]] || fail "mantle aws table"
[[ "$(count '^OpenAI-Project = "proj_abc"$')" == 1 ]] || fail "mantle project header in config.toml"
[[ "$(count '^\[model_providers\.amazon-bedrock-runtime\.aws\]')" == 1 ]] || fail "runtime provider table must stay"
[[ -f "${R}" ]] || fail "runtime profile missing"
[[ "$(rc '^model_provider = "amazon-bedrock-runtime"$')" == 1 ]] || fail "runtime profile provider"
[[ "$(rc '^web_search = "disabled"$')" == 1 ]] || fail "runtime profile web search"
snap_m="$(cat "${M}")"; snap_c="$(cat "${H}/.codex/config.toml")"
run setup
[[ "$(cat "${M}")" == "${snap_m}" ]] || fail "mantle profile not idempotent"
[[ "$(cat "${H}/.codex/config.toml")" == "${snap_c}" ]] || fail "mantle-default config.toml not idempotent"
env -i HOME="${H}" PATH="/usr/bin:/bin" "${CLI}" status 2>/dev/null | grep -q "NOT counted in usage or budget" \
  || fail "status must say mantle is not metered"
echo '{"credentials":{},"mantle":{"enabled":false}}' > "${H}/.config/cc-bedrock/state.json"
run setup
[[ ! -e "${M}" ]] || fail "revoked mantle profile left behind"
[[ ! -e "${R}" ]] || fail "revoked runtime profile left behind"
[[ "$(count 'amazon-bedrock\.|OpenAI-Project')" == 0 ]] || fail "revoked mantle left in config.toml"
[[ "$(count '^model_provider = "amazon-bedrock-runtime"')" == 1 ]] || fail "revoke must restore the runtime default"
# A user's own amazon-bedrock table (a key we don't manage) stays, and keeps runtime the default.
cp "${H}/.codex/config.toml" "${TMPDIR:-/tmp}/ccbl-own.$$"
printf '\n[model_providers.amazon-bedrock.aws]\nregion = "mine"\nservice = "custom"\n' >> "${H}/.codex/config.toml"
echo '{"credentials":{},"mantle":{"enabled":true,"projectId":"proj_abc"}}' > "${H}/.config/cc-bedrock/state.json"
run setup
[[ "$(count '^region = "mine"$')" == 1 ]] || fail "dropped the user's own amazon-bedrock table"
[[ "$(count '^\[model_providers\.amazon-bedrock\.aws\]')" == 1 ]] || fail "duplicate amazon-bedrock table"
[[ "$(count '^model_provider = "amazon-bedrock-runtime"')" == 1 ]] || fail "own table must keep runtime the default"
env -i HOME="${H}" PATH="/usr/bin:/bin" "${CLI}" status 2>/dev/null | grep -q "codex -p mantle only" \
  || fail "status must not call mantle the default when runtime stayed the default"
# Captured first: grep -q would close the pipe early (SIGPIPE under pipefail).
setup_out="$(env -i HOME="${H}" PATH="/usr/bin:/bin" "${CLI}" setup 2>/dev/null)"
grep -q '^✓ codex  → Bedrock (.*: amazon-bedrock-runtime,' <<<"${setup_out}" || fail "setup must report the provider it applied"
# Mixed: a managed-keys-only aws table next to the user's own headers table. The
# provider is the user's as a whole: neither table is touched, runtime stays default.
cp "${TMPDIR:-/tmp}/ccbl-own.$$" "${H}/.codex/config.toml"
printf '\n[model_providers.amazon-bedrock.aws]\nregion = "us-west-2"\n\n[model_providers.amazon-bedrock.http_headers]\nX-Mine = "1"\n' >> "${H}/.codex/config.toml"
run setup
[[ "$(count '^region = "us-west-2"$')" == 1 ]] || fail "mixed: stripped the user's aws table"
[[ "$(count '^X-Mine = "1"$')" == 1 ]] || fail "mixed: stripped the user's headers table"
[[ "$(count '^\[model_providers\.amazon-bedrock\.aws\]')" == 1 ]] || fail "mixed: duplicate aws table"
[[ "$(count '^model_provider = "amazon-bedrock-runtime"')" == 1 ]] || fail "mixed: runtime must stay the default"
cp "${TMPDIR:-/tmp}/ccbl-own.$$" "${H}/.codex/config.toml"
# A leftover unmarked table with only managed keys (a manual `region = "us-east-1"`
# mantle setup, seen on a Mac) is replaced: mantle becomes the default, one table.
printf 'sandbox_mode = "workspace-write"\n\n[model_providers.amazon-bedrock.aws]\nregion = "us-east-1"\n\n[tui]\nx = true\n' > "${H}/.codex/config.toml"
run setup
[[ "$(count '^model_provider = "amazon-bedrock"  # managed by cc-bedrock-local$')" == 1 ]] || fail "leftover table must not block the mantle default"
[[ "$(count '^\[model_providers\.amazon-bedrock\.aws\]')" == 1 ]] || fail "leftover table duplicated"
[[ "$(count '^\[model_providers\.amazon-bedrock\.aws\]  # managed by cc-bedrock-local$')" == 1 ]] || fail "leftover table not replaced by ours"
[[ "$(count '^OpenAI-Project = "proj_abc"$')" == 1 ]] || fail "mantle header missing after replacing leftover"
[[ "$(count '^sandbox_mode = "workspace-write"$')" == 1 ]] || fail "user sandbox_mode lost"
python3 -c 'import sys
try: import tomllib
except ImportError: sys.exit(0)
tomllib.load(open(sys.argv[1], "rb"))' "${H}/.codex/config.toml" || fail "leftover replacement produced invalid TOML"
cp "${TMPDIR:-/tmp}/ccbl-own.$$" "${H}/.codex/config.toml"; rm -f "${TMPDIR:-/tmp}/ccbl-own.$$" "${M}" "${R}"
echo '{"credentials":{},"mantle":{"enabled":false}}' > "${H}/.config/cc-bedrock/state.json"
run setup
printf 'model = "mine"\n' > "${M}"
echo '{"credentials":{},"mantle":{"enabled":true,"projectId":"proj_abc"}}' > "${H}/.config/cc-bedrock/state.json"
run setup
[[ "$(cat "${M}")" == 'model = "mine"' ]] || fail "overwrote the user's own mantle.config.toml"
run unsetup
[[ "$(cat "${M}")" == 'model = "mine"' ]] || fail "unsetup removed the user's own mantle.config.toml"
rm -f "${M}" "${H}/.config/cc-bedrock/state.json"

# A user who already picked a Codex sandbox keeps it (profiles and sandbox_mode don't compose).
printf 'sandbox_mode = "danger-full-access"\n' > "${H}/.codex/config.toml"
run setup
[[ "$(count '^default_permissions')" == 0 ]] || fail "overrode the user's sandbox_mode"
[[ "$(count '^sandbox_mode = "danger-full-access"')" == 1 ]] || fail "user sandbox_mode lost"
grep -q "sets its own sandbox" "${TMP}/stderr.log" || fail "no warning about the missing read deny"
# Quiet re-sync (credential renewal / login) must honour the user's sandbox too.
quiet() { env -i HOME="${H}" PATH="/usr/bin:/bin" CC_BEDROCK_QUIET=1 "${CLI}" "$@" >/dev/null 2>>"${TMP}/stderr.log"; }
quiet setup
[[ "$(count '^default_permissions')" == 0 ]] || fail "quiet re-sync overrode the user's sandbox_mode"
printf 'default_permissions = "mine"\n' > "${H}/.codex/config.toml"
quiet setup
[[ "$(count '^default_permissions')" == 1 ]] || fail "quiet re-sync duplicated default_permissions"
# tomllib needs Python 3.11; older system pythons skip the parse (the count above still holds).
python3 -c 'import sys
try: import tomllib
except ImportError: sys.exit(0)
tomllib.load(open(sys.argv[1], "rb"))' "${H}/.codex/config.toml" || fail "quiet re-sync produced invalid TOML"

# The user's own amazon-bedrock provider tables are not ours to strip from config.toml,
# even with only keys we also manage, while there is no mantle grant.
printf '[model_providers.amazon-bedrock.aws]\nprofile = "mine"\n' > "${H}/.codex/config.toml"
run setup
[[ "$(count '^\[model_providers\.amazon-bedrock\.aws\]$')" == 1 ]] || fail "stripped the user's own amazon-bedrock table"
[[ "$(count '^profile = "mine"$')" == 1 ]] || fail "rewrote the user's own amazon-bedrock table"

# A UTF-8 BOM (Windows editors) is ignored, as the PowerShell CLI does: the first-line
# `model =` is still replaced (no duplicate key) and a BOM'd settings.json still parses.
printf '\xef\xbb\xbfmodel = "mine"\n' > "${H}/.codex/config.toml"
printf '\xef\xbb\xbf{"env":{"FOO":"1"}}' > "${H}/.claude/settings.json"
run setup
[[ "$(count '^model = ')" == 1 ]] || fail "BOM config.toml: duplicate model key"
[[ "$(json 'd["env"]["FOO"]')" == 1 ]] || fail "BOM settings.json not parsed"
# status reports the token cache age in UTC, whatever the local time zone.
printf '{"refreshToken":"r","obtainedAt":%s}' "$(date +%s)" > "${H}/.config/cc-bedrock/cognito-tokens.json"
echo "{\"credentials\":{\"expiration\":\"${exp}\"}}" > "${H}/.config/cc-bedrock/state.json"
env -i HOME="${H}" PATH="/usr/bin:/bin" TZ=Asia/Seoul "${CLI}" status 2>/dev/null | grep -q "age 0m" \
  || fail "status age is time-zone dependent"
rm -f "${H}/.config/cc-bedrock/cognito-tokens.json" "${H}/.config/cc-bedrock/state.json"

# A broken settings.json is reported, never overwritten.
echo '{broken' > "${H}/.claude/settings.json"
if run setup 2>/dev/null; then fail "setup accepted invalid JSON"; fi
[[ "$(cat "${H}/.claude/settings.json")" == '{broken' ]] || fail "invalid settings.json overwritten"

echo "cc-bedrock-local setup: OK"
