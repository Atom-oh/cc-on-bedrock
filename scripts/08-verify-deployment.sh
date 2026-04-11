#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Post-Deployment Verification
# Checks all deployed resources are healthy and reachable.
#
# Usage: ./08-verify-deployment.sh [domain-name]
# Example: ./08-verify-deployment.sh atomai.click

DOMAIN_NAME="${1:-${DOMAIN_NAME:-atomai.click}}"
REGION="${AWS_REGION:-ap-northeast-2}"
PROJECT_PREFIX="cc-on-bedrock"
ERRORS=0
WARNINGS=0

header() { echo -e "\n\033[1;36m=== $1 ===\033[0m"; }
ok()     { echo -e "  \033[32m[OK]\033[0m $1"; }
warn()   { echo -e "  \033[33m[WARN]\033[0m $1"; WARNINGS=$((WARNINGS + 1)); }
fail()   { echo -e "  \033[31m[FAIL]\033[0m $1"; ERRORS=$((ERRORS + 1)); }

echo "=== CC-on-Bedrock Deployment Verification ==="
echo "Domain: $DOMAIN_NAME"
echo "Region: $REGION"

# --- CDK Stacks ---
header "1. CloudFormation Stacks"
EXPECTED_STACKS=(
  "CcOnBedrock-Network"
  "CcOnBedrock-Security"
  "CcOnBedrock-UsageTracking"
  "CcOnBedrock-WAF"
  "CcOnBedrock-Ec2Devenv"
  "CcOnBedrock-EcsDevenv"
  "CcOnBedrock-Dashboard"
)

for STACK in "${EXPECTED_STACKS[@]}"; do
  if [ "$STACK" = "CcOnBedrock-WAF" ]; then
    CHECK_REGION="us-east-1"
  else
    CHECK_REGION="$REGION"
  fi
  STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$CHECK_REGION" \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$STATUS" == *"COMPLETE"* ]]; then
    ok "$STACK ($STATUS)"
  elif [ "$STATUS" = "NOT_FOUND" ]; then
    warn "$STACK not deployed"
  else
    fail "$STACK ($STATUS)"
  fi
done

# --- Cognito ---
header "2. Cognito User Pool"
USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 20 --region "$REGION" \
  --query "UserPools[?contains(Name, '${PROJECT_PREFIX}')].Id | [0]" --output text 2>/dev/null || echo "None")
if [ -n "$USER_POOL_ID" ] && [ "$USER_POOL_ID" != "None" ]; then
  ok "User Pool: $USER_POOL_ID"
  USER_COUNT=$(aws cognito-idp list-users --user-pool-id "$USER_POOL_ID" --region "$REGION" \
    --query "length(Users)" --output text 2>/dev/null || echo "0")
  ok "Users: $USER_COUNT"

  # Check for IdP federation
  IDP_COUNT=$(aws cognito-idp list-identity-providers --user-pool-id "$USER_POOL_ID" --region "$REGION" \
    --query "length(Providers)" --output text 2>/dev/null || echo "0")
  if [ "$IDP_COUNT" != "0" ]; then
    ok "Federation: $IDP_COUNT identity provider(s)"
  else
    ok "Federation: Native Cognito only"
  fi
else
  fail "Cognito User Pool not found"
fi

# --- SSM Parameters ---
header "3. SSM Parameters"
SSM_PARAMS=(
  "/${PROJECT_PREFIX}/cognito/user-pool-id"
  "/${PROJECT_PREFIX}/cognito/client-id"
  "/${PROJECT_PREFIX}/cognito/client-secret"
  "/${PROJECT_PREFIX}/devenv/ami-id/ubuntu"
)

for PARAM in "${SSM_PARAMS[@]}"; do
  VALUE=$(aws ssm get-parameter --name "$PARAM" --region "$REGION" \
    --query "Parameter.Value" --output text 2>/dev/null || echo "NOT_FOUND")
  if [ "$VALUE" != "NOT_FOUND" ]; then
    DISPLAY="${VALUE:0:20}..."
    ok "$PARAM = $DISPLAY"
  else
    warn "$PARAM not set"
  fi
done

# Check AL2023 AMI (optional)
AL2023_AMI=$(aws ssm get-parameter --name "/${PROJECT_PREFIX}/devenv/ami-id/al2023" --region "$REGION" \
  --query "Parameter.Value" --output text 2>/dev/null || echo "NOT_FOUND")
if [ "$AL2023_AMI" != "NOT_FOUND" ]; then
  ok "/${PROJECT_PREFIX}/devenv/ami-id/al2023 = $AL2023_AMI"
else
  warn "AL2023 AMI not built yet (optional)"
fi

# --- ECR Repositories ---
header "4. ECR Repositories"
for REPO in "cc-on-bedrock/devenv" "cc-on-bedrock/dashboard" "cc-on-bedrock/nginx"; do
  IMAGE_COUNT=$(aws ecr list-images --repository-name "$REPO" --region "$REGION" \
    --query "length(imageIds)" --output text 2>/dev/null || echo "NOT_FOUND")
  if [ "$IMAGE_COUNT" != "NOT_FOUND" ]; then
    ok "$REPO ($IMAGE_COUNT images)"
  else
    warn "$REPO not found"
  fi
done

# --- DynamoDB Tables ---
header "5. DynamoDB Tables"
TABLES=(
  "cc-bedrock-usage"
  "cc-user-instances"
  "cc-department-budgets"
)
for TABLE in "${TABLES[@]}"; do
  STATUS=$(aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" \
    --query "Table.TableStatus" --output text 2>/dev/null || echo "NOT_FOUND")
  if [ "$STATUS" = "ACTIVE" ]; then
    ok "$TABLE ($STATUS)"
  elif [ "$STATUS" = "NOT_FOUND" ]; then
    warn "$TABLE not found"
  else
    fail "$TABLE ($STATUS)"
  fi
done

# --- VPC ---
header "6. Network"
VPC_ID=$(aws ec2 describe-vpcs \
  --filters "Name=tag:Name,Values=*${PROJECT_PREFIX}*" \
  --query "Vpcs[0].VpcId" --output text --region "$REGION" 2>/dev/null || echo "None")
if [ -n "$VPC_ID" ] && [ "$VPC_ID" != "None" ]; then
  ok "VPC: $VPC_ID"
  SUBNET_COUNT=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
    --query "length(Subnets)" --output text --region "$REGION" 2>/dev/null || echo "0")
  ok "Subnets: $SUBNET_COUNT"
  NAT_COUNT=$(aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$VPC_ID" "Name=state,Values=available" \
    --query "length(NatGateways)" --output text --region "$REGION" 2>/dev/null || echo "0")
  ok "NAT Gateways: $NAT_COUNT"
else
  fail "VPC not found"
fi

# --- CloudFront ---
header "7. CloudFront Distributions"
CF_DISTS=$(aws cloudfront list-distributions --query "DistributionList.Items[?contains(Comment, '${PROJECT_PREFIX}') || contains(Aliases.Items, '${DOMAIN_NAME}')].{Id:Id,Domain:DomainName,Status:Status}" --output json 2>/dev/null || echo "[]")
CF_COUNT=$(echo "$CF_DISTS" | jq 'length' 2>/dev/null || echo "0")
if [ "$CF_COUNT" -gt 0 ]; then
  echo "$CF_DISTS" | jq -r '.[] | "  [OK] \(.Id) (\(.Status)) - \(.Domain)"' 2>/dev/null
else
  warn "No CloudFront distributions found"
fi

# --- Bedrock Invocation Logging ---
header "8. Bedrock Invocation Logging"
LOGGING=$(aws bedrock get-model-invocation-logging-configuration --region "$REGION" \
  --query "loggingConfig" --output json 2>/dev/null || echo "null")
if [ "$LOGGING" != "null" ]; then
  ok "Invocation logging enabled"
else
  warn "Invocation logging NOT enabled. Enable in AWS Console > Bedrock > Settings"
fi

# --- Summary ---
header "Summary"
echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo -e "\033[31m$ERRORS error(s), $WARNINGS warning(s)\033[0m"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo -e "\033[33m0 errors, $WARNINGS warning(s)\033[0m"
else
  echo -e "\033[32mAll checks passed! Deployment is healthy.\033[0m"
fi
