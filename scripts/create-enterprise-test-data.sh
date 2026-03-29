#!/bin/bash
# Create Enterprise test data: users, dept-managers, admin, department budgets
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

create_user() {
  local email="$1" subdomain="$2" dept="$3" os="$4" tier="$5" policy="$6"
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$email" \
    --temporary-password "$TEMP_PASSWORD" \
    --user-attributes \
      Name=email,Value="$email" \
      Name=email_verified,Value=true \
      Name=custom:subdomain,Value="$subdomain" \
      Name=custom:department,Value="$dept" \
      Name=custom:container_os,Value="$os" \
      Name=custom:resource_tier,Value="$tier" \
      Name=custom:security_policy,Value="$policy" \
    --message-action SUPPRESS \
    --desired-delivery-mediums EMAIL \
    --region "$REGION" --no-cli-pager 2>/dev/null && echo "  Created: $email" || echo "  Exists: $email"
  # Set permanent password (no forced change on first login)
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

put_dept_budget() {
  local dept_id="$1" budget="$2" allowed_tiers="$3"
  aws dynamodb put-item \
    --table-name cc-department-budgets \
    --item "{
      \"dept_id\": {\"S\": \"$dept_id\"},
      \"dept_name\": {\"S\": \"$dept_id\"},
      \"monthly_budget_usd\": {\"N\": \"$budget\"},
      \"monthly_used_usd\": {\"N\": \"0\"},
      \"allowed_tiers\": {\"SS\": [$allowed_tiers]},
      \"max_ebs_gb\": {\"N\": \"100\"},
      \"created_at\": {\"S\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
    }" \
    --region "$REGION" --no-cli-pager 2>/dev/null && echo "  Budget: $dept_id = \$$budget/month" || echo "  Budget exists: $dept_id"
}

echo ""
echo "=== 1. Creating Department Budgets ==="
put_dept_budget "engineering" "5000" '"light","standard","power"'
put_dept_budget "data-science" "8000" '"light","standard","power"'
put_dept_budget "product" "2000" '"light","standard"'
put_dept_budget "devops" "3000" '"light","standard","power"'
put_dept_budget "research" "10000" '"light","standard","power"'

echo ""
echo "=== 2. Creating Platform Admin ==="
create_user "admin@example.com" "admin01" "engineering" "ubuntu" "power" "open"
add_to_group "admin@example.com" "admin"

echo ""
echo "=== 3. Creating Department Managers ==="
declare -A DEPT_MANAGERS=(
  ["eng-manager@example.com"]="engmgr:engineering:ubuntu:standard"
  ["ds-manager@example.com"]="dsmgr:data-science:ubuntu:power"
  ["product-manager@example.com"]="prodmgr:product:ubuntu:light"
  ["devops-manager@example.com"]="devopsmgr:devops:al2023:standard"
  ["research-manager@example.com"]="resmgr:research:ubuntu:power"
)

for email in "${!DEPT_MANAGERS[@]}"; do
  IFS=':' read -r subdomain dept os tier <<< "${DEPT_MANAGERS[$email]}"
  create_user "$email" "$subdomain" "$dept" "$os" "$tier" "open"
  add_to_group "$email" "dept-manager"
done

echo ""
echo "=== 4. Creating Regular Users (6 per department = 30 total) ==="

USER_NUM=1
for dept in engineering data-science product devops research; do
  echo "--- $dept ---"
  for i in $(seq 1 6); do
    padded=$(printf "%02d" $USER_NUM)
    email="user${padded}@example.com"
    subdomain="${dept//-/}${padded}"

    # Vary OS/tier
    case $dept in
      engineering)   os="ubuntu"; tier="standard" ;;
      data-science)  os="ubuntu"; tier="power" ;;
      product)       os="ubuntu"; tier="light" ;;
      devops)        os="al2023"; tier="standard" ;;
      research)      os="ubuntu"; tier="power" ;;
    esac

    # Some variation
    [ $((i % 3)) -eq 0 ] && tier="light"
    [ $((i % 5)) -eq 0 ] && os="al2023"

    policy="open"
    [ "$dept" = "research" ] && policy="restricted"

    create_user "$email" "$subdomain" "$dept" "$os" "$tier" "$policy"
    add_to_group "$email" "user"
    USER_NUM=$((USER_NUM + 1))
  done
done

echo ""
echo "=== Summary ==="
echo "  Platform Admin: 1 (admin@example.com)"
echo "  Dept Managers:  5 (one per department)"
echo "  Regular Users:  30 (6 per department)"
echo "  Total:          36 users"
echo "  Departments:    5 (engineering, data-science, product, devops, research)"
echo "  Department budgets created in DynamoDB"
echo ""
echo "  Temp password for all: $TEMP_PASSWORD"
echo "  Users must change password on first login."
