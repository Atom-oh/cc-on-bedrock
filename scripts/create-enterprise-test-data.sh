#!/bin/bash
# Seed Cognito users grouped by department.
#
# Roster: 1 admin + 30 regular users (6 per dept). The first user in each
# department is added to the `dept-manager` group; the rest go to `user`.
# Manager identity is intentionally NOT encoded in the email so a manager
# change is just a group reassignment — no email rotation needed.
#
# Scope: Cognito users + group membership only. Everything else (IAM roles,
# instance profiles, canonical custom:subdomain, custom:dept_manager_sub)
# is filled in automatically by the user-role-provisioner Lambda (ADR-022)
# on the AdminCreateUser / AdminAddUserToGroup CloudTrail events.
#
# Usage: USER_POOL_ID=ap-northeast-2_XXXXX bash scripts/create-enterprise-test-data.sh
set -euo pipefail

REGION="${REGION:-ap-northeast-2}"
USER_POOL_ID="${USER_POOL_ID:-}"
TEMP_PASSWORD="!234Qwer"

if [ -z "$USER_POOL_ID" ]; then
  USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 --region "$REGION" \
    --query "UserPools[?contains(Name,'cc-on-bedrock')].Id | [0]" --output text 2>/dev/null || echo "")
  if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
    echo "ERROR: USER_POOL_ID not found. Set USER_POOL_ID env var."
    exit 1
  fi
fi
echo "Using User Pool: $USER_POOL_ID"

# Single source of truth: department roster.
#   "<dept>:<default_os>:<default_tier>:<default_policy>"
DEPARTMENTS=(
  "engineering:ubuntu:standard:open"
  "data-science:ubuntu:power:open"
  "product:ubuntu:light:open"
  "devops:al2023:standard:open"
  "research:ubuntu:power:restricted"
)
USERS_PER_DEPT=6

create_user() {
  # Subdomain is intentionally NOT set here. The user-role-provisioner Lambda
  # (ADR-022) derives `custom:subdomain` from the email local-part on the
  # CloudTrail AdminCreateUser event, so every entry point — this seed script,
  # dashboard /api/users POST, AWS Console, SDK — converges on the same value.
  local email="$1" dept="$2" os="$3" tier="$4" policy="$5"
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$email" \
    --temporary-password "$TEMP_PASSWORD" \
    --user-attributes \
      Name=email,Value="$email" \
      Name=email_verified,Value=true \
      Name=custom:department,Value="$dept" \
      Name=custom:container_os,Value="$os" \
      Name=custom:resource_tier,Value="$tier" \
      Name=custom:security_policy,Value="$policy" \
    --message-action SUPPRESS \
    --desired-delivery-mediums EMAIL \
    --region "$REGION" --no-cli-pager 2>/dev/null && echo "  Created: $email" || echo "  Exists: $email"
  aws cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$email" \
    --password "$TEMP_PASSWORD" \
    --permanent \
    --region "$REGION" 2>/dev/null || true
}

add_to_group() {
  local email="$1" group="$2"
  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$USER_POOL_ID" \
    --username "$email" \
    --group-name "$group" \
    --region "$REGION" 2>/dev/null && echo "  -> Group: $group" || echo "  -> Group $group (already)"
}

echo ""
echo "=== Platform Admin ==="
# Admin is dept-less (custom:department=platform is for tagging only). Group decides authority.
create_user "admin@example.com" "platform" "ubuntu" "power" "open"
add_to_group "admin@example.com" "admin"

USER_NUM=1
for entry in "${DEPARTMENTS[@]}"; do
  IFS=':' read -r dept os tier policy <<< "$entry"

  echo ""
  echo "=== $dept ==="

  for i in $(seq 1 "$USERS_PER_DEPT"); do
    padded=$(printf "%02d" $USER_NUM)
    email="user${padded}@example.com"
    create_user "$email" "$dept" "$os" "$tier" "$policy"
    # First user per dept becomes the dept-manager (group membership only —
    # no special email). The rest are regular users. The provisioner Lambda
    # reads the dept-manager group on AdminAddUserToGroup and propagates the
    # manager's sub to custom:dept_manager_sub on all dept members.
    if [ "$i" -eq 1 ]; then
      add_to_group "$email" "dept-manager"
    else
      add_to_group "$email" "user"
    fi
    USER_NUM=$((USER_NUM + 1))
  done
done

echo ""
echo "=== Summary ==="
TOTAL_USERS=$((USER_NUM - 1))
echo "  Platform Admin: 1 (admin@example.com)"
echo "  Cognito users:  ${TOTAL_USERS} (${USERS_PER_DEPT} per department, 1st-of-each = dept-manager)"
echo "  Departments:    ${#DEPARTMENTS[@]} ($(IFS=', '; echo "${DEPARTMENTS[*]%%:*}"))"
echo ""
echo "  Permanent password for all: $TEMP_PASSWORD"
echo ""
echo "  Per-user IAM roles, instance profiles, custom:subdomain, and"
echo "  custom:dept_manager_sub are filled in automatically by the"
echo "  user-role-provisioner Lambda within ~10s of each event (ADR-022)."
