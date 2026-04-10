#!/usr/bin/env bash
# migrate-role-tags.sh — Add cost allocation tags to existing per-user IAM roles.
#
# Reads all IAM roles matching cc-on-bedrock-task-* and adds:
#   - username: from Cognito custom:subdomain lookup
#   - department: from Cognito custom:department lookup
#   - project: cc-on-bedrock
#
# These tags enable AWS Bedrock IAM Cost Allocation (CUR 2.0 + Cost Explorer).
#
# Usage:
#   bash scripts/migrate-role-tags.sh                     # Execute migration
#   bash scripts/migrate-role-tags.sh --dry-run            # Preview only, no changes
#   COGNITO_USER_POOL_ID=ap-northeast-2_xxx bash scripts/migrate-role-tags.sh

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY RUN] No changes will be made."
fi

REGION="${AWS_REGION:-ap-northeast-2}"
USER_POOL_ID="${COGNITO_USER_POOL_ID:-}"
ROLE_PREFIX="cc-on-bedrock-task-"

# Auto-discover Cognito User Pool ID from SSM if not set
if [[ -z "$USER_POOL_ID" ]]; then
  echo "[INFO] COGNITO_USER_POOL_ID not set. Trying SSM parameter..."
  USER_POOL_ID=$(aws ssm get-parameter \
    --name "/cc-on-bedrock/cognito/user-pool-id" \
    --region "$REGION" \
    --query "Parameter.Value" \
    --output text 2>/dev/null || true)
fi

if [[ -z "$USER_POOL_ID" ]]; then
  echo "[ERROR] Cognito User Pool ID not found. Set COGNITO_USER_POOL_ID or SSM parameter."
  exit 1
fi

echo "[INFO] Region: $REGION"
echo "[INFO] User Pool: $USER_POOL_ID"
echo ""

# Build Cognito user lookup map: subdomain → (username, department)
declare -A USER_DEPT_MAP
declare -A USER_NAME_MAP

echo "[INFO] Fetching Cognito users..."
PAGINATION_TOKEN=""
USER_COUNT=0

while true; do
  if [[ -z "$PAGINATION_TOKEN" ]]; then
    RESULT=$(aws cognito-idp list-users \
      --user-pool-id "$USER_POOL_ID" \
      --region "$REGION" \
      --limit 60 \
      --output json 2>/dev/null)
  else
    RESULT=$(aws cognito-idp list-users \
      --user-pool-id "$USER_POOL_ID" \
      --region "$REGION" \
      --limit 60 \
      --pagination-token "$PAGINATION_TOKEN" \
      --output json 2>/dev/null)
  fi

  # Parse users
  USERS=$(echo "$RESULT" | jq -c '.Users[]')
  while IFS= read -r user; do
    USERNAME=$(echo "$user" | jq -r '.Username')
    SUBDOMAIN=$(echo "$user" | jq -r '(.Attributes // []) | map(select(.Name == "custom:subdomain")) | .[0].Value // empty')
    DEPARTMENT=$(echo "$user" | jq -r '(.Attributes // []) | map(select(.Name == "custom:department")) | .[0].Value // "default"')

    if [[ -n "$SUBDOMAIN" ]]; then
      USER_DEPT_MAP["$SUBDOMAIN"]="$DEPARTMENT"
      USER_NAME_MAP["$SUBDOMAIN"]="$USERNAME"
      ((USER_COUNT++))
    fi
  done <<< "$USERS"

  PAGINATION_TOKEN=$(echo "$RESULT" | jq -r '.PaginationToken // empty')
  if [[ -z "$PAGINATION_TOKEN" ]]; then
    break
  fi
done

echo "[INFO] Found $USER_COUNT Cognito users with subdomain."
echo ""

# List all cc-on-bedrock-task-* roles and tag them
echo "[INFO] Scanning IAM roles matching ${ROLE_PREFIX}*..."
TAGGED=0
SKIPPED=0
ERRORS=0

ROLES=$(aws iam list-roles \
  --region "$REGION" \
  --query "Roles[?starts_with(RoleName, '${ROLE_PREFIX}')].RoleName" \
  --output text 2>/dev/null)

for ROLE_NAME in $ROLES; do
  SUBDOMAIN="${ROLE_NAME#${ROLE_PREFIX}}"

  USERNAME="${USER_NAME_MAP[$SUBDOMAIN]:-}"
  DEPARTMENT="${USER_DEPT_MAP[$SUBDOMAIN]:-default}"

  if [[ -z "$USERNAME" ]]; then
    echo "[SKIP] $ROLE_NAME — no matching Cognito user for subdomain '$SUBDOMAIN'"
    ((SKIPPED++))
    continue
  fi

  echo "[TAG]  $ROLE_NAME → username=$USERNAME, department=$DEPARTMENT, project=cc-on-bedrock"

  if [[ "$DRY_RUN" == "false" ]]; then
    if aws iam tag-role \
      --role-name "$ROLE_NAME" \
      --tags \
        "Key=username,Value=$USERNAME" \
        "Key=department,Value=$DEPARTMENT" \
        "Key=project,Value=cc-on-bedrock" \
      --region "$REGION" 2>/dev/null; then
      ((TAGGED++))
    else
      echo "[ERROR] Failed to tag $ROLE_NAME"
      ((ERRORS++))
    fi
  else
    ((TAGGED++))
  fi
done

echo ""
echo "========================================="
echo "Migration Summary"
echo "========================================="
echo "  Tagged:  $TAGGED"
echo "  Skipped: $SKIPPED"
echo "  Errors:  $ERRORS"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  (DRY RUN — no actual changes made)"
fi
echo ""
echo "[NEXT] Activate cost allocation tags in AWS Billing console:"
echo "  1. Go to Billing → Cost Allocation Tags"
echo "  2. Search for: username, department, project"
echo "  3. Activate each tag"
echo "  4. Wait 24h for tags to appear in Cost Explorer"
