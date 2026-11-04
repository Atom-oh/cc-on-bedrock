#!/usr/bin/env bash
# cc-bedrock-local session-report: parses fixture Claude Code transcripts (main file +
# subagents/, duplicate assistant message ids, meta / tool_result / compact /
# local-command lines, two UTC days) and a fixture Codex rollout into per-session
# buckets, checks the exact numbers, then exercises the real POST + state path
# against a local HTTP stub (offline): incremental parsing, dedupe across runs,
# no state save on failure, the Stop hook payload, truncation and SESSION_REPORT=off.
set -euo pipefail
cd "$(dirname "$0")/../.."

_t="${TMPDIR:-/tmp}"; TMP="$(mktemp -d "${_t%/}/ccbl-sr.XXXXXX")"
STUB_PID=""
cleanup() { [[ -n "${STUB_PID}" ]] && kill "${STUB_PID}" 2>/dev/null || true; rm -rf "${TMP}"; }
trap cleanup EXIT
H="${TMP}/home"
CLI="${TMP}/bin/cc-bedrock-local"
CFG="${H}/.config/cc-bedrock"
PROJ="${H}/.claude/projects/-work-proj"
MAIN="${PROJ}/sess-1.jsonl"
SUB="${PROJ}/sess-1/subagents/agent-a1.jsonl"
D1="$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(days=2)).strftime("%Y-%m-%d"))')"
D2="$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(days=1)).strftime("%Y-%m-%d"))')"
ROLL="${H}/.codex/sessions/${D2//-//}/rollout-${D2}T01-00-00-codex-1.jsonl"
mkdir -p "${CFG}" "${PROJ}/sess-1/subagents" "$(dirname "${ROLL}")" "${TMP}/bin"
cp tools/cc-bedrock-local.sh "${CLI}"
chmod +x "${CLI}"

fail() { echo "FAIL: $*" >&2; exit 1; }
cat > "${CFG}/config" <<'EOF'
DASHBOARD_URL=https://dashboard.example.invalid
COGNITO_CLIENT_ID=client
EMAIL=user@example.com
EOF

# jl <file> <python dict literal>: append one compact JSON line (D1/D2 substituted).
jl() {
  python3 -c 'import ast,json,sys; sys.stdout.write(json.dumps(ast.literal_eval(sys.argv[2].replace("D1", sys.argv[3]).replace("D2", sys.argv[4])), separators=(",",":")) + "\n")' \
    "$1" "$2" "${D1}" "${D2}" >> "$1"
}
U() { echo "{'type':'user','sessionId':'sess-1','timestamp':'$1','message':{'role':'user','content':$2}$3}"; }
A() { echo "{'type':'assistant','sessionId':'sess-1','timestamp':'$1','message':{'id':'$2','model':'$3','usage':{'input_tokens':$4,'output_tokens':$5,'cache_read_input_tokens':$6,'cache_creation_input_tokens':$7}}$8}"; }

# --- Claude main transcript --------------------------------------------------
jl "${MAIN}" "$(U D1T23:50:00.000Z "'hello'" '')"                                       # turn D1
jl "${MAIN}" "$(A D1T23:50:05.100Z msg_a claude-opus-5-5 10 5 100 50 '')"
jl "${MAIN}" "$(A D1T23:50:06.200Z msg_a claude-opus-5-5 10 20 100 50 '')"            # same id: max, not sum
jl "${MAIN}" "$(U D1T23:50:07.000Z "[{'type':'tool_result','tool_use_id':'t1','content':'ok'}]" '')"
jl "${MAIN}" "$(A D1T23:50:08.000Z msg_b claude-opus-5-5 1 2 3 4 '')"
jl "${MAIN}" "$(U D1T23:50:09.000Z "'<system-reminder>x</system-reminder>'" ",'isMeta':True")"
jl "${MAIN}" "$(U D1T23:50:10.000Z "'This session is being continued'" ",'isCompactSummary':True")"
jl "${MAIN}" "$(U D1T23:50:11.000Z "'<local-command-stdout>done</local-command-stdout>'" '')"
jl "${MAIN}" "$(U D1T23:50:12.000Z "'<local-command-caveat>Caveat</local-command-caveat>'" '')"
jl "${MAIN}" "$(U D1T23:50:13.000Z "'<command-stdout>x</command-stdout>'" '')"
jl "${MAIN}" "{'type':'system','subtype':'turn_duration','sessionId':'sess-1','timestamp':'D1T23:50:14.000Z'}"
jl "${MAIN}" "$(U D2T00:10:00.000Z "[{'type':'text','text':'second prompt'}]" '')"      # turn D2
jl "${MAIN}" "$(A D2T00:10:05.000Z msg_c claude-sonnet-5-5 7 8 9 10 '')"
jl "${MAIN}" "$(A D2T00:10:06.000Z msg_s '<synthetic>' 1 1 1 1 '')"
# --- Claude subagent transcript (requests count for the parent, turns never) --
jl "${SUB}" "$(U D2T00:11:00.000Z "'subagent task'" ",'isSidechain':True")"
jl "${SUB}" "$(A D2T00:11:05.000Z msg_d claude-haiku-5-5 2 3 4 5 ",'isSidechain':True")"
# --- Codex rollout -----------------------------------------------------------
jl "${ROLL}" "{'timestamp':'D2T01:00:00.000Z','type':'session_meta','payload':{'id':'codex-1','cwd':'/w'}}"
jl "${ROLL}" "{'timestamp':'D2T01:00:01.000Z','type':'turn_context','payload':{'model':'gpt-a'}}"
jl "${ROLL}" "{'timestamp':'D2T01:00:02.000Z','type':'event_msg','payload':{'type':'task_started','turn_attribution':{'turn_trigger':'user'}}}"
jl "${ROLL}" "{'timestamp':'D2T01:00:03.000Z','type':'event_msg','payload':{'type':'task_started','turn_attribution':{'turn_trigger':'agent'}}}"
jl "${ROLL}" "{'timestamp':'D2T01:00:04.000Z','type':'event_msg','payload':{'type':'token_count','info':None}}"
jl "${ROLL}" "{'timestamp':'D2T01:00:05.000Z','type':'event_msg','payload':{'type':'token_count','info':{'last_token_usage':{'input_tokens':100,'cached_input_tokens':30,'cache_write_input_tokens':20,'output_tokens':7}}}}"
jl "${ROLL}" "{'timestamp':'D2T01:00:06.000Z','type':'turn_context','payload':{'model':'gpt-b'}}"
jl "${ROLL}" "{'timestamp':'D2T01:00:07.000Z','type':'event_msg','payload':{'type':'task_started'}}"
jl "${ROLL}" "{'timestamp':'D2T01:00:08.000Z','type':'event_msg','payload':{'type':'token_count','info':{'last_token_usage':{'input_tokens':10,'cached_input_tokens':20,'output_tokens':1}}}}"
# An incomplete last line (still being written) is not consumed.
printf '%s' '{"type":"assistant","sessionId":"sess-1","timestamp":"' >> "${MAIN}"

ENV=(env -i HOME="${H}" PATH="/usr/bin:/bin")
dry() { "${ENV[@]}" "${CLI}" session-report --dry-run --sweep 2>>"${TMP}/stderr.log"; }
# check <buckets json> <python assertion over b = {key: bucket}>; the assertion is a
# test-authored expression (same pattern as json() in test-cc-bedrock-local-setup.sh).
check() {
  python3 -c '
import json, sys
b = {"%s|%s|%s" % (x["tool"], x["sessionId"], x["date"]): x for x in json.loads(sys.argv[1])["buckets"]}
D1, D2 = sys.argv[3], sys.argv[4]
ok = eval(sys.argv[2])
if not ok:
    print(json.dumps(b, indent=1)); sys.exit(1)' "$1" "$2" "${D1}" "${D2}"
}
M() { echo "{'requests':$1,'inputTokens':$2,'outputTokens':$3,'cacheReadTokens':$4,'cacheWriteTokens':$5}"; }

out="$(dry)"
check "${out}" "len(b) == 3" || fail "expected 3 buckets"
check "${out}" "b['claude|sess-1|'+D1] == {'tool':'claude','sessionId':'sess-1','date':D1,'firstAt':D1+'T23:50:00.000Z','lastAt':D1+'T23:50:08.000Z','turns':1,'models':{'claude-opus-5-5':$(M 2 11 22 103 54)}}" \
  || fail "claude day-1 bucket"
check "${out}" "b['claude|sess-1|'+D2] == {'tool':'claude','sessionId':'sess-1','date':D2,'firstAt':D2+'T00:10:00.000Z','lastAt':D2+'T00:11:05.000Z','turns':1,'models':{'claude-haiku-5-5':$(M 1 2 3 4 5),'claude-sonnet-5-5':$(M 1 7 8 9 10)}}" \
  || fail "claude day-2 bucket (subagent requests, no subagent turn, no <synthetic>)"
check "${out}" "b['codex|codex-1|'+D2] == {'tool':'codex','sessionId':'codex-1','date':D2,'firstAt':D2+'T01:00:02.000Z','lastAt':D2+'T01:00:08.000Z','turns':2,'models':{'gpt-a':$(M 1 50 7 30 20),'gpt-b':$(M 1 0 1 20 0)}}" \
  || fail "codex bucket"
[[ ! -e "${CFG}/sessions-state.json" ]] || fail "dry run saved state"

# --- local HTTP stub: records requests; returns the status in ${TMP}/status ---
echo 200 > "${TMP}/status"
cat > "${TMP}/stub.py" <<'PY'
import http.server, json, sys
root = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with open(root + "/requests.jsonl", "a") as f:
            f.write(json.dumps({"path": self.path, "auth": self.headers.get("Authorization"),
                                "ctype": self.headers.get("Content-Type"), "body": json.loads(body)}) + "\n")
        code = int(open(root + "/status").read().strip())
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"accepted":1}')
    def log_message(self, *a):
        pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(root + "/port", "w").write(str(s.server_port))
s.serve_forever()
PY
python3 "${TMP}/stub.py" "${TMP}" &
STUB_PID=$!
for _ in $(seq 1 50); do [[ -s "${TMP}/port" ]] && break; python3 -c 'import time; time.sleep(0.1)'; done
[[ -s "${TMP}/port" ]] || fail "stub did not start"
EP="http://127.0.0.1:$(cat "${TMP}/port")/api/local/sessions"
exp_at="$(( $(date +%s) + 3600 ))"
printf '{"accessToken":"tok.en.x","accessExpiresAt":%s,"refreshToken":"r","obtainedAt":%s}' "${exp_at}" "$(date +%s)" > "${CFG}/cognito-tokens.json"
RUN=(env -i HOME="${H}" PATH="/usr/bin:/bin" CC_BEDROCK_SESSION_ENDPOINT="${EP}")
nreq() { [[ -f "${TMP}/requests.jsonl" ]] && wc -l < "${TMP}/requests.jsonl" | tr -d ' ' || echo 0; }
lastreq() { tail -n 1 "${TMP}/requests.jsonl"; }

"${RUN[@]}" "${CLI}" session-report --sweep > "${TMP}/out.txt" 2>>"${TMP}/stderr.log" || fail "sweep failed: $(cat "${TMP}/stderr.log")"
[[ "$(nreq)" == 1 ]] || fail "expected one POST, got $(nreq)"
python3 -c '
import json, sys
r = json.loads(sys.argv[1])
assert r["path"] == "/api/local/sessions", r["path"]
assert r["auth"] == "Bearer tok.en.x", r["auth"]
assert r["ctype"] == "application/json", r["ctype"]
assert len(r["body"]["buckets"]) == 3, r["body"]
' "$(lastreq)" || fail "POST shape"
check "$(lastreq | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["body"]))')" \
  "b['claude|sess-1|'+D1]['models']['claude-opus-5-5'] == $(M 2 11 22 103 54)" || fail "POSTed bucket differs from dry run"
grep -q '^session-report: .* 3 session bucket(s) sent$' "${TMP}/out.txt" || fail "summary line: $(cat "${TMP}/out.txt")"
[[ -f "${CFG}/sessions-state.json" ]] || fail "state not saved after 2xx"
[[ "$(stat -c %a "${CFG}/sessions-state.json" 2>/dev/null || stat -f %Lp "${CFG}/sessions-state.json")" == 600 ]] || fail "state file not owner-only"
check "$(dry)" "b == {}" || fail "no dirty buckets expected after a successful POST"
"${RUN[@]}" "${CLI}" session-report --sweep >/dev/null 2>>"${TMP}/stderr.log"
[[ "$(nreq)" == 1 ]] || fail "unchanged buckets were sent again"

# --- incremental: completing the partial line + a duplicate id with a higher count
printf '%s\n' 'D2T00:12:00.000Z","message":{"id":"msg_e","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":1,"cache_creation_input_tokens":1}}}' \
  | sed "s/D2/${D2}/" >> "${MAIN}"
jl "${MAIN}" "$(A D2T00:12:01.000Z msg_c claude-sonnet-5-5 7 30 9 10 '')"   # msg_c seen in the last run
out="$(dry)"
check "${out}" "list(b) == ['claude|sess-1|'+D2]" || fail "only the changed bucket is dirty"
check "${out}" "b['claude|sess-1|'+D2]['models'] == {'claude-haiku-5-5':$(M 1 2 3 4 5),'claude-opus-5-5':$(M 1 1 1 1 1),'claude-sonnet-5-5':$(M 1 7 30 9 10)}" \
  || fail "cumulative totals after append (dedupe across runs)"
check "${out}" "b['claude|sess-1|'+D2]['lastAt'] == D2+'T00:12:00.000Z'" || fail "lastAt after append"

# --- failure: no state save, the same bucket stays dirty; --quiet still exits 0
echo 500 > "${TMP}/status"
snap="$(cat "${CFG}/sessions-state.json")"
if "${RUN[@]}" "${CLI}" session-report --sweep >/dev/null 2>>"${TMP}/stderr.log"; then fail "HTTP 500 reported success"; fi
[[ "$(cat "${CFG}/sessions-state.json")" == "${snap}" ]] || fail "state saved after a failed POST"
[[ "$(nreq)" == 2 ]] || fail "expected the failed POST to reach the stub"
"${RUN[@]}" "${CLI}" session-report --sweep --quiet > "${TMP}/q.txt" 2>&1 || fail "--quiet must exit 0"
[[ ! -s "${TMP}/q.txt" ]] || fail "--quiet wrote output: $(cat "${TMP}/q.txt")"
grep -q 'HTTP 500' "${CFG}/session-report.log" || fail "failure not logged"
[[ "$(stat -c %a "${CFG}/session-report.log" 2>/dev/null || stat -f %Lp "${CFG}/session-report.log")" == 600 ]] || fail "log not owner-only"
check "$(dry)" "list(b) == ['claude|sess-1|'+D2]" || fail "bucket must stay dirty after a failure"
echo 200 > "${TMP}/status"
"${RUN[@]}" "${CLI}" session-report --sweep >/dev/null 2>>"${TMP}/stderr.log" || fail "retry failed"
check "$(lastreq | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["body"]))')" \
  "list(b) == ['claude|sess-1|'+D2] and b['claude|sess-1|'+D2]['models']['claude-sonnet-5-5']['outputTokens'] == 30" || fail "retry body"
check "$(dry)" "b == {}" || fail "dirty after the retry"
# A validation rejection (400) must not block state saves forever.
jl "${MAIN}" "$(A D2T00:13:00.000Z msg_r claude-opus-5-5 1 1 1 1 '')"
echo 400 > "${TMP}/status"
"${RUN[@]}" "${CLI}" session-report --sweep > "${TMP}/rej.txt" 2>>"${TMP}/stderr.log" || fail "a 400 must not fail the run"
grep -q '1 rejected' "${TMP}/rej.txt" || fail "rejection not reported: $(cat "${TMP}/rej.txt")"
check "$(dry)" "b == {}" || fail "rejected bucket must not be retried until it changes"
echo 200 > "${TMP}/status"

# --- Stop hook: payload on stdin, transcript + its subagents; no sweep within 10 min
jl "${MAIN}" "$(U D2T00:20:00.000Z "'third prompt'" '')"
jl "${SUB}" "$(A D2T00:20:05.000Z msg_f claude-haiku-5-5 1 1 1 1 ",'isSidechain':True")"
before="$(nreq)"
printf '{"session_id":"sess-1","transcript_path":"%s","hook_event_name":"Stop"}' "${MAIN}" \
  | "${RUN[@]}" "${CLI}" session-report --quiet > "${TMP}/hook.txt" 2>&1 || fail "hook mode must exit 0"
[[ ! -s "${TMP}/hook.txt" ]] || fail "hook mode wrote output: $(cat "${TMP}/hook.txt")"
[[ "$(nreq)" == $(( before + 1 )) ]] || fail "hook mode did not POST"
check "$(lastreq | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["body"]))')" \
  "list(b) == ['claude|sess-1|'+D2] and b['claude|sess-1|'+D2]['turns'] == 2 and b['claude|sess-1|'+D2]['models']['claude-haiku-5-5']['requests'] == 2" \
  || fail "hook bucket"
# Hook output is never fatal, even for garbage input.
echo 'not json' | "${RUN[@]}" "${CLI}" session-report --quiet >/dev/null 2>&1 || fail "garbage hook input must exit 0"

# --- truncated / rotated file restarts from 0
: > "${ROLL}"
jl "${ROLL}" "{'timestamp':'D2T02:00:00.000Z','type':'session_meta','payload':{'id':'codex-1'}}"
jl "${ROLL}" "{'timestamp':'D2T02:00:01.000Z','type':'event_msg','payload':{'type':'task_started'}}"
check "$(dry)" "b == {}" || fail "model-less bucket after truncation must not be dirty"
jl "${ROLL}" "{'timestamp':'D2T02:00:02.000Z','type':'event_msg','payload':{'type':'token_count','info':{'last_token_usage':{'input_tokens':5,'cached_input_tokens':0,'output_tokens':2}}}}"
check "$(dry)" "b['codex|codex-1|'+D2]['turns'] == 1 and b['codex|codex-1|'+D2]['models'] == {'unknown':$(M 1 5 2 0 0)}" \
  || fail "truncated rollout must be re-read from 0"

# --- no token: skipped silently in --quiet, logged
mv "${CFG}/cognito-tokens.json" "${TMP}/tokens.bak"
before="$(nreq)"
"${RUN[@]}" "${CLI}" session-report --sweep --quiet >/dev/null 2>&1 || fail "no-token --quiet must exit 0"
[[ "$(nreq)" == "${before}" ]] || fail "POST without a token"
grep -q 'no Cognito session' "${CFG}/session-report.log" || fail "no-token skip not logged"
mv "${TMP}/tokens.bak" "${CFG}/cognito-tokens.json"

# --- expired cached access token without a reachable Cognito: no prompt, no POST, exit 0
printf '{"accessToken":"old","accessExpiresAt":%s,"refreshToken":"r","obtainedAt":0}' "$(( $(date +%s) + 60 ))" > "${CFG}/cognito-tokens.json"
"${RUN[@]}" COGNITO_REGION=invalid.localhost "${CLI}" session-report --sweep --quiet </dev/null >/dev/null 2>&1 || fail "stale token --quiet must exit 0"
[[ "$(nreq)" == "${before}" ]] || fail "POST with a token that has < 5 min left"
printf '{"accessToken":"tok.en.x","accessExpiresAt":%s,"refreshToken":"r","obtainedAt":%s}' "${exp_at}" "$(date +%s)" > "${CFG}/cognito-tokens.json"

# --- SESSION_REPORT=off disables everything
echo 'SESSION_REPORT=off' >> "${CFG}/config"
jl "${MAIN}" "$(U D2T00:30:00.000Z "'fourth prompt'" '')"
snap="$(cat "${CFG}/sessions-state.json")"
"${RUN[@]}" "${CLI}" session-report --sweep > "${TMP}/off.txt" 2>&1 || fail "off must exit 0"
[[ ! -s "${TMP}/off.txt" && "$(nreq)" == "${before}" ]] || fail "SESSION_REPORT=off still reported"
[[ "$(cat "${CFG}/sessions-state.json")" == "${snap}" ]] || fail "SESSION_REPORT=off touched state"

echo "cc-bedrock-local session-report: OK"
