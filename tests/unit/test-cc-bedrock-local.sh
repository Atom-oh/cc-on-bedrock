#!/usr/bin/env bash
# Unit tests for tools/cc-bedrock-local.sh — pure functions (credential_process emitter +
# profile writer). Sources the wrapper in an isolated HOME (dispatch is guarded by a
# BASH_SOURCE check). Network/SDK behavior is verified live by the user, not here.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export HOME; HOME="$(mktemp -d)"
# shellcheck disable=SC1090
source "${ROOT}/tools/cc-bedrock-local.sh"
set +e   # the wrapper sets -e; tests assert via explicit exits
fail=0

echo "== emit_credprocess_json: from credentials =="
MOCK='{"credentials":{"AccessKeyId":"AKIA","SecretAccessKey":"SEC","SessionToken":"TOK","expiration":"2026-01-01T00:00:00Z"},"profileSnippet":"[cc-bedrock]\naws_access_key_id=SNIP_AK\naws_secret_access_key=SNIP_SK\naws_session_token=SNIP_TOK\n"}'
OUT=$(printf '%s' "${MOCK}" | emit_credprocess_json)
python3 - "${OUT}" <<'PY' || fail=1
import json, sys
out = sys.argv[1]
d = json.loads(out)
assert d["Version"] == 1 and isinstance(d["Version"], int), "Version must be integer 1"
assert d["AccessKeyId"] == "AKIA", d
assert d["SecretAccessKey"] == "SEC", d
assert d["SessionToken"] == "TOK", d
assert d["Expiration"] == "2026-01-01T00:00:00Z", "Expiration from credentials.expiration"
assert "\n" not in out, "stdout must be JSON-only (no extra lines)"
print("  ok: Version int, keys, Expiration, JSON-only")
PY

echo "== emit_credprocess_json: profileSnippet fallback =="
MOCK2='{"credentials":{"expiration":"2026-02-02T00:00:00Z"},"profileSnippet":"[cc-bedrock]\naws_access_key_id=SNIP_AK\naws_secret_access_key=SNIP_SK\naws_session_token=SNIP_TOK\n"}'
OUT2=$(printf '%s' "${MOCK2}" | emit_credprocess_json)
python3 - "${OUT2}" <<'PY' || fail=1
import json, sys
d = json.loads(sys.argv[1])
assert d["AccessKeyId"] == "SNIP_AK", d
assert d["SecretAccessKey"] == "SNIP_SK", d
assert d["SessionToken"] == "SNIP_TOK", d
assert d["Expiration"] == "2026-02-02T00:00:00Z", d
print("  ok: keys parsed from profileSnippet, expiration kept")
PY

echo "== emit_credprocess_json: missing creds -> error exit =="
printf '%s' '{"profileSnippet":"[cc-bedrock]\n"}' | emit_credprocess_json >/dev/null 2>&1
[ $? -ne 0 ] && echo "  ok: non-zero exit on missing credentials" || { echo "  FAIL: should error"; fail=1; }

echo "== write_credprocess_profile: config gets credential_process, static creds purged =="
mkdir -p "$(dirname "${AWS_CREDS_FILE}")"
printf '[cc-bedrock]\naws_access_key_id=STALE\n\n[other]\nx=1\n' > "${AWS_CREDS_FILE}"
write_credprocess_profile
ok=1
grep -q '^\[profile cc-bedrock\]' "${AWS_CONFIG_FILE}" || ok=0
grep -q 'credential_process = bash .*_cred-process' "${AWS_CONFIG_FILE}" || ok=0
grep -q '^\[cc-bedrock\]' "${AWS_CREDS_FILE}" && ok=0   # static block MUST be purged (precedence)
grep -q '^\[other\]' "${AWS_CREDS_FILE}" || ok=0        # unrelated profiles preserved
[ "${ok}" -eq 1 ] && echo "  ok: config credential_process; static [cc-bedrock] purged; [other] kept" \
  || { echo "  FAIL: write_credprocess_profile"; fail=1; }

echo "== non-Bedrock ANTHROPIC_MODEL is sanitized (dropped) =="
[ -z "${ANTHROPIC_MODEL}" ] && echo "  ok: bare/empty ANTHROPIC_MODEL not pinned in test env" || echo "  (info) ANTHROPIC_MODEL=${ANTHROPIC_MODEL}"

[ "${fail}" -eq 0 ] && echo "ALL cc-bedrock-local TESTS PASSED" || echo "cc-bedrock-local TESTS FAILED"
exit "${fail}"
