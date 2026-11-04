#!/usr/bin/env bash
# cc-bedrock-local.ps1 (Windows CLI) parity with cc-bedrock-local.sh: both run
# setup on identical throwaway HOMEs and must produce the same Codex config,
# mantle profile and Claude settings (except the credential command line); then
# unsetup, credential-process (cache hit) and set-model are checked on the PS side.
# Needs pwsh (PowerShell 7) on PATH; skips with a notice otherwise. No network.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v pwsh >/dev/null 2>&1; then
  echo "SKIP: pwsh not installed — cc-bedrock-local.ps1 parity test not run"
  exit 0
fi

_t="${TMPDIR:-/tmp}"; TMP="$(mktemp -d "${_t%/}/ccbl-ps1.XXXXXX")"  # macOS TMPDIR ends in /
trap 'rm -rf "${TMP}"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

seed() {  # seed <home>
  local h="$1"
  mkdir -p "${h}/.config/cc-bedrock" "${h}/.claude" "${h}/.codex"
  cat > "${h}/.config/cc-bedrock/config" <<'EOF'
DASHBOARD_URL=https://dashboard.example.invalid
COGNITO_CLIENT_ID=client
EMAIL=user@example.com
CODEX_MODEL=global.openai.gpt-6.1-sol
EOF
  echo '{"permissions":{"allow":["Bash(ls)"]},"env":{"FOO":"1"}}' > "${h}/.claude/settings.json"
  cat > "${h}/.codex/config.toml" <<'EOF'
model = "gpt-5"
approval_policy = "never"

[profiles.work]
model = "o3"

[model_providers.amazon-bedrock-runtime.aws]
region = "us-east-1"
EOF
  cat > "${h}/.config/cc-bedrock/state.json" <<'EOF'
{"credentials":{"accessKeyId":"AKIA","secretAccessKey":"SECRET","sessionToken":"TOKEN","expiration":"2099-01-01T00:00:00Z"},
 "mantle":{"enabled":true,"projectId":"proj_123","region":"us-east-1","model":"openai.gpt-6.1-sol"}}
EOF
}

HB="${TMP}/bash-home"; HP="${TMP}/ps-home"
mkdir -p "${TMP}/bin"
cp tools/cc-bedrock-local.sh "${TMP}/bin/cc-bedrock-local"; chmod +x "${TMP}/bin/cc-bedrock-local"
cp tools/cc-bedrock-local.ps1 "${TMP}/bin/cc-bedrock-local.ps1"
PWSH="$(command -v pwsh)"
seed "${HB}"; seed "${HP}"

runb() { env -i HOME="${HB}" PATH="/usr/bin:/bin" "${TMP}/bin/cc-bedrock-local" "$@"; }
runp() { env -i HOME="${HP}" PATH="/usr/bin:/bin" "${PWSH}" -NoProfile -NonInteractive -File "${TMP}/bin/cc-bedrock-local.ps1" "$@"; }

# The Codex permission deny names the CLI dir, which differs per HOME.
norm() { sed -e "s#${HB}#HOME#g" -e "s#${HP}#HOME#g" "$1"; }

runb setup >/dev/null 2>&1 || fail "bash setup"
runp setup >/dev/null 2>"${TMP}/ps.err" || { cat "${TMP}/ps.err" >&2; fail "ps1 setup"; }

diff <(norm "${HB}/.codex/config.toml") <(norm "${HP}/.codex/config.toml") || fail "codex config.toml differs from bash"
diff <(norm "${HB}/.codex/mantle.config.toml") <(norm "${HP}/.codex/mantle.config.toml") || fail "mantle.config.toml differs from bash"
diff <(norm "${HB}/.codex/runtime.config.toml") <(norm "${HP}/.codex/runtime.config.toml") || fail "runtime.config.toml differs from bash"
cmp -s <(sed -n 's/^credential_process = //p' "${HP}/.aws/config") <(echo "pwsh -NoProfile -NonInteractive -File \"${TMP}/bin/cc-bedrock-local.ps1\" credential-process") \
  || fail "credential_process line: $(grep credential_process "${HP}/.aws/config")"

python3 - "${HB}/.claude/settings.json" "${HP}/.claude/settings.json" <<'PY' || fail "claude settings differ from bash"
import json, sys
b, p = (json.load(open(f)) for f in sys.argv[1:3])
assert p["awsCredentialExport"].endswith(" credential-process"), p["awsCredentialExport"]
b.pop("awsCredentialExport"); p.pop("awsCredentialExport")
# The session-report Stop hook embeds the same per-CLI command prefix.
for d in (b, p):
    for g in d.get("hooks", {}).get("Stop", []):
        for h in g.get("hooks", []):
            if h.get("command", "").endswith(" session-report --quiet"):
                h["command"] = "<cli> session-report --quiet"
assert b == p, (b, p)
PY

# Idempotent: a second setup changes nothing.
cp "${HP}/.codex/config.toml" "${TMP}/codex.1"; cp "${HP}/.claude/settings.json" "${TMP}/claude.1"
runp setup >/dev/null 2>&1
cmp -s "${TMP}/codex.1" "${HP}/.codex/config.toml" || fail "second setup changed config.toml"
cmp -s "${TMP}/claude.1" "${HP}/.claude/settings.json" || fail "second setup changed settings.json"

# credential-process: cache hit prints exactly one JSON line on stdout.
out="$(runp credential-process 2>/dev/null)"
python3 - "${out}" <<'PY' || fail "credential-process output: ${out}"
import json, sys
lines = sys.argv[1].splitlines()
assert len(lines) == 1, lines
d = json.loads(lines[0])
assert d == {"Version": 1, "AccessKeyId": "AKIA", "SecretAccessKey": "SECRET",
             "SessionToken": "TOKEN", "Expiration": "2099-01-01T00:00:00Z"}, d
PY

# set-model follows into both clients.
runp set-model opus=global.anthropic.claude-opus-5 >/dev/null 2>&1
grep -q '^ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-5$' "${HP}/.config/cc-bedrock/config" || fail "set-model config"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"]=="global.anthropic.claude-opus-5"' "${HP}/.claude/settings.json" || fail "set-model settings"

# unsetup: same result as bash unsetup.
runb unsetup >/dev/null 2>&1; runp unsetup >/dev/null 2>&1
diff <(norm "${HB}/.codex/config.toml") <(norm "${HP}/.codex/config.toml") || fail "codex config after unsetup differs from bash"
python3 - "${HB}/.claude/settings.json" "${HP}/.claude/settings.json" <<'PY' || fail "claude settings after unsetup differ"
import json, sys
b, p = (json.load(open(f)) for f in sys.argv[1:3])
assert b == p == {"permissions": {"allow": ["Bash(ls)"]}, "env": {"FOO": "1"}}, (b, p)
PY
[[ ! -e "${HP}/.codex/mantle.config.toml" ]] || fail "unsetup left mantle.config.toml"
[[ ! -e "${HP}/.codex/runtime.config.toml" ]] || fail "unsetup left runtime.config.toml"

echo "PASS: cc-bedrock-local.ps1 matches cc-bedrock-local.sh"
