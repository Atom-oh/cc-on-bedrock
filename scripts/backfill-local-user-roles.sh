#!/bin/bash
# Backfill per-user Local Governance IAM roles for every Cognito user (ADR-022).
#
# Walks all users in the cc-on-bedrock User Pool and invokes the
# user-role-provisioner Lambda once per user. Idempotent — already-provisioned
# users hit the exists-branch of role_factory.ensure_role.
#
# Use after deploying Stack 08 with ADR-022 changes, to cover users that were
# created before the EventBridge pre-provisioner existed.
#
# Usage:
#   USER_POOL_ID=ap-northeast-2_XXXXX bash scripts/backfill-local-user-roles.sh
set -euo pipefail

REGION="${REGION:-ap-northeast-2}"
USER_POOL_ID="${USER_POOL_ID:-}"
FUNCTION_NAME="${FUNCTION_NAME:-cc-on-bedrock-user-role-provisioner}"

if [ -z "$USER_POOL_ID" ]; then
  USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 --region "$REGION" \
    --query "UserPools[?contains(Name,'cc-on-bedrock')].Id | [0]" --output text 2>/dev/null || echo "")
  if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
    echo "ERROR: USER_POOL_ID not found. Set USER_POOL_ID env var."
    exit 1
  fi
fi

echo "User Pool : $USER_POOL_ID"
echo "Function  : $FUNCTION_NAME"
echo ""

# Dump all users via `aws cognito-idp list-users` (CLI handles pagination via --no-paginate
# loop) into a single JSONL stream (action + sub + username + department + project).
> /tmp/backfill-users.jsonl
TOKEN=""
while :; do
  if [ -n "$TOKEN" ]; then
    PAGE=$(aws cognito-idp list-users --user-pool-id "$USER_POOL_ID" \
      --region "$REGION" --limit 60 --pagination-token "$TOKEN" --output json)
  else
    PAGE=$(aws cognito-idp list-users --user-pool-id "$USER_POOL_ID" \
      --region "$REGION" --limit 60 --output json)
  fi

  echo "$PAGE" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for u in data.get("Users", []):
    attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
    sub = attrs.get("sub")
    if not sub:
        continue
    print(json.dumps({
        "action": "ensure",
        "sub": sub,
        "username": attrs.get("email") or u.get("Username") or sub,
        "department": attrs.get("custom:department", "default"),
        "project": attrs.get("custom:project", "default"),
    }))
' >> /tmp/backfill-users.jsonl

  TOKEN=$(echo "$PAGE" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('PaginationToken',''))")
  [ -z "$TOKEN" ] && break
done

TOTAL=$(wc -l < /tmp/backfill-users.jsonl | tr -d ' ')
echo "Found $TOTAL Cognito users — invoking provisioner per user..."
echo ""

PROCESSED=0
CREATED=0
EXISTING=0
FAILED=0

while IFS= read -r LINE; do
  PARSED=$(echo "$LINE" | python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(d['sub'],d['username'],d['department'],d['project'])")
  SUB=$(echo "$PARSED" | awk '{print $1}')
  USERNAME=$(echo "$PARSED" | awk '{print $2}')
  DEPT=$(echo "$PARSED" | awk '{print $3}')
  PROJECT=$(echo "$PARSED" | awk '{print $4}')

  if RESP=$(aws lambda invoke --function-name "$FUNCTION_NAME" --region "$REGION" \
      --cli-binary-format raw-in-base64-out \
      --payload "$LINE" /tmp/backfill-out.json 2>&1); then
    OUT=$(cat /tmp/backfill-out.json)
    # The Lambda's ensure path returns a nested shape:
    #   {"sub":"...","subdomain":"...","localGovRole":{"created":bool,...},"ec2Role":{"created":bool,...}, ...}
    # "CREATED" status means at least one role was just created on this call;
    # if both report created=False the user already had everything in place.
    CREATED_FLAG=$(echo "$OUT" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
local = (d.get('localGovRole') or {}).get('created')
ec2 = (d.get('ec2Role') or {}).get('created')
if local is True or ec2 is True:
    print('True')
elif local is False or ec2 is False:
    print('False')
else:
    print('None')
" 2>/dev/null || echo "None")
    if [ "$CREATED_FLAG" = "True" ]; then
      echo "  CREATED $USERNAME ($DEPT)"
      CREATED=$((CREATED + 1))
    elif [ "$CREATED_FLAG" = "False" ]; then
      echo "  EXISTS  $USERNAME ($DEPT)"
      EXISTING=$((EXISTING + 1))
    else
      echo "  ?       $USERNAME ($DEPT) — unexpected response: $OUT"
      FAILED=$((FAILED + 1))
    fi
    PROCESSED=$((PROCESSED + 1))
  else
    echo "  FAIL    $USERNAME ($SUB): $RESP"
    FAILED=$((FAILED + 1))
  fi
done < /tmp/backfill-users.jsonl

echo ""
echo "=== Summary ==="
echo "  Processed: $PROCESSED"
echo "  Created:   $CREATED"
echo "  Existing:  $EXISTING"
echo "  Failed:    $FAILED"
