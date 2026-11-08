#!/usr/bin/env bash
# cc-bedrock-local silent refresh (credential-process / refresh) against a fake curl
# (offline): GetTokensFromRefreshToken is used, a rotated refresh token is stored,
# stdout stays one JSON line, a dead session and a network failure give distinct
# messages, a cache hit makes no network call, and concurrent credential-process
# calls issue STS credentials once (the refresh lock + cache re-check).
set -euo pipefail
cd "$(dirname "$0")/../.."

_t="${TMPDIR:-/tmp}"; TMP="$(mktemp -d "${_t%/}/ccbl-rf.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT
H="${TMP}/home"; CFG="${H}/.config/cc-bedrock"; CLI="${TMP}/bin/cc-bedrock-local"
mkdir -p "${CFG}" "${TMP}/bin" "${TMP}/fakebin"
cp tools/cc-bedrock-local.sh "${CLI}"; chmod +x "${CLI}"
fail() { echo "FAIL: $*" >&2; exit 1; }

cat > "${CFG}/config" <<'EOF'
DASHBOARD_URL=https://dashboard.example.invalid
COGNITO_REGION=ap-northeast-2
COGNITO_CLIENT_ID=client
EMAIL=user@example.com
SESSION_REPORT=off
EOF

# Fake curl: answers by X-Amz-Target / URL; MODE selects the Cognito outcome.
cat > "${TMP}/fakebin/curl" <<'EOF'
#!/usr/bin/env bash
target="" url="" data=""
while (( $# )); do
  case "$1" in
    -H) [[ "$2" == X-Amz-Target:* ]] && target="${2#X-Amz-Target: }"; shift 2 ;;
    --data) data="$2"; shift 2 ;;
    --max-time|-X|-K|-o|-w) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
echo "${target:-${url}}" >> "${FAKE_DIR}/calls.log"
mode="$(cat "${FAKE_DIR}/mode")"
if [[ -n "${target}" ]]; then
  echo "${data}" > "${FAKE_DIR}/last-cognito-body"
  case "${mode}" in
    network) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
    dead) echo '{"__type":"NotAuthorizedException","message":"Refresh Token has expired"}' ;;
    rotate) echo '{"AuthenticationResult":{"AccessToken":"h.eyJleHAiOjQxMDI0NDQ4MDB9.s","RefreshToken":"rt-new"}}' ;;
    *) echo '{"AuthenticationResult":{"AccessToken":"h.eyJleHAiOjQxMDI0NDQ4MDB9.s"}}' ;;
  esac
  exit 0
fi
sleep 1  # a slow issue, so concurrent callers overlap
exp="$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc)+d.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
echo "{\"credentials\":{\"accessKeyId\":\"AK\",\"secretAccessKey\":\"SK\",\"sessionToken\":\"ST\",\"expiration\":\"${exp}\"}}"
EOF
chmod +x "${TMP}/fakebin/curl"

export HOME="${H}" FAKE_DIR="${TMP}" PATH="${TMP}/fakebin:${PATH}"
unset CC_BEDROCK_DASHBOARD_URL CC_BEDROCK_EMAIL AWS_PROFILE_NAME CLAUDE_CONFIG_DIR CODEX_HOME || true
tokens() { echo '{"accessToken":"old","accessExpiresAt":0,"refreshToken":"rt-old","obtainedAt":0}' > "${CFG}/cognito-tokens.json"; }
expired_state() { echo '{"credentials":{"accessKeyId":"A","secretAccessKey":"S","sessionToken":"T","expiration":"2000-01-01T00:00:00Z"}}' > "${CFG}/state.json"; }
reset() { : > "${TMP}/calls.log"; echo "$1" > "${TMP}/mode"; tokens; expired_state; rm -rf "${CFG}/refresh.lock"; }

# 1) expired creds -> refresh via GetTokensFromRefreshToken, rotated token stored, one JSON line
reset rotate
out="$("${CLI}" credential-process 2>"${TMP}/err")" || fail "credential-process failed: $(cat "${TMP}/err")"
[[ "$(printf '%s\n' "${out}" | wc -l | tr -d ' ')" == 1 ]] || fail "stdout must be one line: ${out}"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["Version"]==1 and d["AccessKeyId"]=="AK", d' "${out}" || fail "bad JSON: ${out}"
grep -qx 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken' "${TMP}/calls.log" || fail "not GetTokensFromRefreshToken: $(cat "${TMP}/calls.log")"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d=={"ClientId":"client","RefreshToken":"rt-old"}, d' "${TMP}/last-cognito-body" || fail "request body"
python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); assert t["refreshToken"]=="rt-new" and t["accessExpiresAt"]==4102444800, t' "${CFG}/cognito-tokens.json" || fail "rotated refresh token not stored"
[[ ! -e "${CFG}/refresh.lock" ]] || fail "lock left behind"

# 2) no rotation: the old refresh token is kept
reset plain
"${CLI}" credential-process >/dev/null 2>"${TMP}/err" || fail "plain refresh failed: $(cat "${TMP}/err")"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["refreshToken"]=="rt-old"' "${CFG}/cognito-tokens.json" || fail "refresh token lost"

# 3) cache hit: no network call
: > "${TMP}/calls.log"
"${CLI}" credential-process >/dev/null 2>&1 || fail "cache hit failed"
[[ ! -s "${TMP}/calls.log" ]] || fail "cache hit made calls: $(cat "${TMP}/calls.log")"

# 4) dead session vs network failure: exit 1, nothing on stdout, distinct messages
reset dead
if out="$("${CLI}" credential-process 2>"${TMP}/err")"; then fail "dead session must fail"; fi
[[ -z "${out}" ]] || fail "stdout not empty on failure"
grep -q "sign-in expired or revoked" "${TMP}/err" || fail "dead message: $(cat "${TMP}/err")"
reset network
if "${CLI}" credential-process >/dev/null 2>"${TMP}/err"; then fail "network failure must fail"; fi
grep -q "could not reach Cognito" "${TMP}/err" || fail "network message: $(cat "${TMP}/err")"
grep -q "expired" "${TMP}/err" && fail "network failure reported as expiry: $(cat "${TMP}/err")"
"${CLI}" refresh >/dev/null 2>"${TMP}/err" && fail "refresh must fail on network error"
grep -q "could not reach Cognito" "${TMP}/err" || fail "refresh network message"

# 5) concurrent credential-process: one issue, every caller gets credentials
reset plain
for i in 1 2 3 4; do ( "${CLI}" credential-process > "${TMP}/out.$i" 2>"${TMP}/err.$i"; echo $? > "${TMP}/rc.$i" ) & done
wait
for i in 1 2 3 4; do
  [[ "$(cat "${TMP}/rc.$i")" == 0 ]] || fail "concurrent caller $i failed: $(cat "${TMP}/err.$i")"
  grep -q '"AccessKeyId"' "${TMP}/out.$i" || fail "caller $i got no credentials"
done
n="$(grep -c 'api/local/credentials' "${TMP}/calls.log" || true)"
[[ "${n}" == 1 ]] || fail "expected 1 STS issue for 4 concurrent callers, got ${n}"

echo "cc-bedrock-local refresh: OK"
