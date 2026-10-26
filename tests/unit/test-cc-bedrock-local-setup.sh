#!/usr/bin/env bash
# cc-bedrock-local setup/unsetup: writes ~/.claude/settings.json and
# ~/.codex/config.toml so plain `claude` / `codex` use Bedrock, keeps the user's
# own keys, is idempotent, follows set-model, and unsetup removes only its keys.
# Runs in a throwaway HOME with a clean env (no network, no AWS calls).
set -euo pipefail
cd "$(dirname "$0")/../.."

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ccbl-setup.XXXXXX")"
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
exp="$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"
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

run unsetup
[[ "$(json 'd["env"]')" == "{'FOO': '1'}" ]] || fail "unsetup left managed env keys"
[[ "$(json '"awsCredentialExport" in d')" == False ]] || fail "unsetup left awsCredentialExport"
[[ "$(count 'managed by cc-bedrock-local|amazon-bedrock-runtime|^profile = ')" == 0 ]] || fail "unsetup left codex keys"
[[ "$(count '^approval_policy = "never"')" == 1 ]] || fail "unsetup dropped user codex key"
[[ "$(json '"deny" in d["permissions"]')" == False ]] || fail "unsetup left the claude read deny"
[[ "$(count 'permissions|deny')" == 0 ]] || fail "unsetup left the codex permission profile"

# A user who already picked a Codex sandbox keeps it (profiles and sandbox_mode don't compose).
printf 'sandbox_mode = "danger-full-access"\n' > "${H}/.codex/config.toml"
run setup
[[ "$(count '^default_permissions')" == 0 ]] || fail "overrode the user's sandbox_mode"
[[ "$(count '^sandbox_mode = "danger-full-access"')" == 1 ]] || fail "user sandbox_mode lost"
grep -q "sets its own sandbox" "${TMP}/stderr.log" || fail "no warning about the missing read deny"

# A broken settings.json is reported, never overwritten.
echo '{broken' > "${H}/.claude/settings.json"
if run setup 2>/dev/null; then fail "setup accepted invalid JSON"; fi
[[ "$(cat "${H}/.claude/settings.json")" == '{broken' ]] || fail "invalid settings.json overwritten"

echo "cc-bedrock-local setup: OK"
