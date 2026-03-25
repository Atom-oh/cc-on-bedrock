#!/bin/bash
# Create 30 test users across 5 departments with varying configurations
# Usage: bash scripts/create-test-users-30.sh

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
DOMAIN="${DOMAIN_NAME:-whchoi.net}"
DASHBOARD_URL="https://cconbedrock-dashboard.${DOMAIN}"
API_COOKIE="" # Will need auth cookie

# Department configuration: name, user_count, default_os, default_tier
declare -a DEPARTMENTS=(
  "engineering:8:ubuntu:standard"
  "data-science:6:ubuntu:power"
  "product:6:ubuntu:light"
  "devops:5:al2023:standard"
  "research:5:ubuntu:power"
)

# User numbering
USER_NUM=1

echo "=== Creating 30 test users across 5 departments ==="
echo ""

for dept_config in "${DEPARTMENTS[@]}"; do
  IFS=':' read -r dept count default_os default_tier <<< "$dept_config"
  echo "--- Department: $dept ($count users, $default_os/$default_tier) ---"

  for i in $(seq 1 "$count"); do
    padded=$(printf "%02d" $USER_NUM)
    username="${dept}-${padded}"
    email="${username}@${DOMAIN}"
    subdomain="${dept}${padded}"

    # Vary OS and tier within department
    os=$default_os
    tier=$default_tier

    # Some variation: every 3rd user gets different tier
    case $((USER_NUM % 3)) in
      0) tier="power" ;;
      1) tier=$default_tier ;;
      2) tier="light" ;;
    esac

    # Every 4th user uses al2023 regardless of department default
    if [ $((USER_NUM % 4)) -eq 0 ]; then
      os="al2023"
    fi

    echo "  Creating: $username ($email) subdomain=$subdomain dept=$dept os=$os tier=$tier"

    # Create Cognito user via Dashboard API
    # Note: This requires authentication. Use curl with session cookie.
    # For direct creation, use AWS CLI:

    aws cognito-idp admin-create-user \
      --user-pool-id "$(aws cognito-idp list-user-pools --max-results 10 --region $REGION --query "UserPools[?Name=='cc-on-bedrock-users'].Id | [0]" --output text 2>/dev/null || echo '')" \
      --username "$email" \
      --user-attributes \
        Name=email,Value="$email" \
        Name=email_verified,Value=true \
        Name=custom:subdomain,Value="$subdomain" \
        Name=custom:department,Value="$dept" \
        Name=custom:container_os,Value="$os" \
        Name=custom:resource_tier,Value="$tier" \
        Name=custom:security_policy,Value="open" \
      --desired-delivery-mediums EMAIL \
      --region "$REGION" \
      --no-cli-pager 2>&1 | grep -o '"Username": "[^"]*"' || echo "  (may already exist)"

    # Add to user group
    aws cognito-idp admin-add-user-to-group \
      --user-pool-id "$(aws cognito-idp list-user-pools --max-results 10 --region $REGION --query "UserPools[?Name=='cc-on-bedrock-users'].Id | [0]" --output text 2>/dev/null || echo '')" \
      --username "$email" \
      --group-name "user" \
      --region "$REGION" 2>/dev/null || true

    USER_NUM=$((USER_NUM + 1))
  done
  echo ""
done

echo "=== Done: Created $((USER_NUM - 1)) users ==="
echo ""
echo "User distribution:"
echo "  engineering: 8 users (ubuntu/standard, mixed tiers)"
echo "  data-science: 6 users (ubuntu/power, mixed tiers)"
echo "  product: 6 users (ubuntu/light, mixed tiers)"
echo "  devops: 5 users (al2023/standard, mixed tiers)"
echo "  research: 5 users (ubuntu/power, mixed tiers)"
