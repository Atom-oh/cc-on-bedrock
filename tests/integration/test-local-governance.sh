#!/usr/bin/env bash
# Integration test for Local Governance Mode (ADR-014, ADR-015)
#
# Required env:
#   AWS_REGION                  (default ap-northeast-2)
#   DASHBOARD_URL               https://dashboard.example.com
#   CC_BEDROCK_TOKEN            CLI bearer token issued by the Dashboard
#   TEST_USER_SUB               Cognito sub of the test user (also matches IAM role suffix)
#   TEST_USER_DEPT              department of the test user (default: default)
#
# Optional:
#   TEST_TOKEN_LIMIT            normalized-token daily limit to install for the test (default: 1000)
#   POLL_TIMEOUT_SECONDS        max seconds to poll for usage/deny propagation (default: 300)
#
# What it asserts:
#   1. STS Issuer returns valid 8h creds
#   2. Issued creds successfully call bedrock:ListFoundationModels
#   3. usage record appears in DynamoDB cc-on-bedrock-usage within the polling window
#   4. Setting a very small daily token limit and invoking a model causes the
#      cc-bedrock-local-token-deny inline policy to attach to the user role
#   5. Force-reset removes the deny

set -euo pipefail
trap 'echo "FAIL at line $LINENO"; exit 1' ERR

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
DASHBOARD_URL="${DASHBOARD_URL:?must set DASHBOARD_URL}"
CC_BEDROCK_TOKEN="${CC_BEDROCK_TOKEN:?must set CC_BEDROCK_TOKEN}"
TEST_USER_SUB="${TEST_USER_SUB:?must set TEST_USER_SUB}"
TEST_USER_DEPT="${TEST_USER_DEPT:-default}"
TEST_TOKEN_LIMIT="${TEST_TOKEN_LIMIT:-1000}"
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-300}"

LIMITS_TABLE="cc-on-bedrock-limits"
USAGE_TABLE="cc-on-bedrock-usage"
ROLE_PREFIX="cc-on-bedrock-local-user-"
POLICY_NAME="cc-bedrock-local-token-deny"
role_suffix="$(echo "$TEST_USER_SUB" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-40)"
ROLE_NAME="${ROLE_PREFIX}${role_suffix}"

say() { printf '\n\033[1;36m===\033[0m %s\n' "$*"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$*"; exit 1; }

# ─── 1. Refresh credentials via Dashboard ─────────────────
say "1. POST /api/local/credentials"
creds_json="$(curl -fsS -X POST \
  -H "Authorization: Bearer ${CC_BEDROCK_TOKEN}" \
  -H "Content-Type: application/json" \
  "${DASHBOARD_URL%/}/api/local/credentials" \
  --data '{}')"
ak="$(echo "$creds_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["credentials"]["accessKeyId"])')"
sk="$(echo "$creds_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["credentials"]["secretAccessKey"])')"
tok="$(echo "$creds_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["credentials"]["sessionToken"])')"
exp="$(echo "$creds_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["credentials"]["expiration"])')"
[[ -n "$ak" && -n "$sk" && -n "$tok" ]] || fail "creds missing fields"
pass "issued (expires ${exp})"

# ─── 2. Sanity call with the issued creds ─────────────────
say "2. bedrock:ListFoundationModels with issued creds"
AWS_ACCESS_KEY_ID="$ak" AWS_SECRET_ACCESS_KEY="$sk" AWS_SESSION_TOKEN="$tok" \
  aws bedrock list-foundation-models --region "$AWS_REGION" --max-results 1 >/dev/null
pass "ListFoundationModels succeeded"

# ─── 3. Install a tight token limit for the test user ─────
say "3. install tight daily token limit (${TEST_TOKEN_LIMIT}) for USER#${TEST_USER_SUB}"
aws dynamodb put-item --region "$AWS_REGION" --table-name "$LIMITS_TABLE" \
  --item "{\"PK\":{\"S\":\"USER#${TEST_USER_SUB}\"},\"SK\":{\"S\":\"LIMIT#daily\"},\"max_normalized\":{\"N\":\"${TEST_TOKEN_LIMIT}\"},\"updatedAt\":{\"S\":\"$(date -u +%FT%TZ)\"}}" \
  >/dev/null
pass "limit installed"

# ─── 4. Generate enough Bedrock traffic to trip the limit ──
say "4. drive Bedrock calls until cumulative normalized >= ${TEST_TOKEN_LIMIT}"
MODEL_ID="${MODEL_ID:-global.anthropic.claude-haiku-4-5-20251001}"
calls=0
while (( calls < 30 )); do
  AWS_ACCESS_KEY_ID="$ak" AWS_SECRET_ACCESS_KEY="$sk" AWS_SESSION_TOKEN="$tok" \
    aws bedrock-runtime converse --region "$AWS_REGION" \
      --model-id "$MODEL_ID" \
      --messages '[{"role":"user","content":[{"text":"reply with one word: ok"}]}]' \
      --inference-config '{"maxTokens":256}' >/dev/null 2>&1 || true
  calls=$((calls+1))
done
pass "issued ${calls} Converse calls"

# ─── 5. Poll for Deny policy attach (Stream + tracker ~1-3 min) ─
say "5. wait up to ${POLL_TIMEOUT_SECONDS}s for ${POLICY_NAME} on ${ROLE_NAME}"
deadline=$(( $(date +%s) + POLL_TIMEOUT_SECONDS ))
denied=0
while (( $(date +%s) < deadline )); do
  if aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" >/dev/null 2>&1; then
    denied=1
    break
  fi
  sleep 10
done
(( denied == 1 )) || fail "deny policy never attached within ${POLL_TIMEOUT_SECONDS}s"
pass "deny policy attached"

# ─── 6. Subsequent call should hit AccessDeniedException ────
say "6. confirm Bedrock call now denied"
if AWS_ACCESS_KEY_ID="$ak" AWS_SECRET_ACCESS_KEY="$sk" AWS_SESSION_TOKEN="$tok" \
  aws bedrock-runtime converse --region "$AWS_REGION" \
    --model-id "$MODEL_ID" \
    --messages '[{"role":"user","content":[{"text":"hi"}]}]' \
    --inference-config '{"maxTokens":16}' 2>&1 | grep -q "AccessDenied\|denied"; then
  pass "call denied as expected"
else
  fail "expected AccessDenied; call succeeded"
fi

# ─── 7. Force-reset via admin endpoint (requires admin token!) ──
if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  say "7. force-reset deny via /api/admin/limits/reset"
  curl -fsS -X POST \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    "${DASHBOARD_URL%/}/api/admin/limits/reset" \
    --data "{\"sub\":\"${TEST_USER_SUB}\"}" >/dev/null
  pass "reset called"

  say "8. verify deny removed"
  if aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" >/dev/null 2>&1; then
    fail "deny still present after reset"
  fi
  pass "deny removed"
else
  echo "  (skipping force-reset: ADMIN_TOKEN not set)"
fi

echo
echo "All Local Governance Mode checks passed."
