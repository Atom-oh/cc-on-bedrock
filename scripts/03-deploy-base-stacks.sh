#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Deploy Base Infrastructure Stacks
# Deploys Network + Security stacks (must come before service stacks).
# Supports CDK context overrides for domain, VPC CIDR, etc.
#
# Usage: ./03-deploy-base-stacks.sh [domain-name] [hosted-zone-id]
# Example: ./03-deploy-base-stacks.sh example.com Z0123456789ABC

DOMAIN_NAME="${1:-}"
HOSTED_ZONE_ID="${2:-}"
REGION="${AWS_REGION:-ap-northeast-2}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$SCRIPT_DIR/../cdk"

echo "=== Deploy Base Infrastructure Stacks ==="
echo "Region: $REGION"

# Build CDK context args
CTX_ARGS=""
if [ -n "$DOMAIN_NAME" ]; then
  CTX_ARGS="$CTX_ARGS -c domainName=$DOMAIN_NAME"
  echo "Domain: $DOMAIN_NAME"
fi
if [ -n "$HOSTED_ZONE_ID" ]; then
  CTX_ARGS="$CTX_ARGS -c hostedZoneId=$HOSTED_ZONE_ID"
  echo "Hosted Zone: $HOSTED_ZONE_ID"
fi
echo ""

cd "$CDK_DIR"

# Stack 01: Network (VPC, Subnets, NAT, Route 53, DNS Firewall)
echo "--- Deploying CcOnBedrock-Network ---"
npx cdk deploy CcOnBedrock-Network \
  --require-approval broadening \
  $CTX_ARGS
echo "  Network stack deployed"
echo ""

# Stack 02: Security (Cognito, ACM, KMS, Secrets Manager, IAM)
echo "--- Deploying CcOnBedrock-Security ---"
npx cdk deploy CcOnBedrock-Security \
  --require-approval broadening \
  $CTX_ARGS
echo "  Security stack deployed"
echo ""

# Capture Cognito outputs for next step
echo "Retrieving Cognito information..."
USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 --region "$REGION" \
  --query "UserPools[?Name=='cc-on-bedrock-user-pool'].Id" --output text 2>/dev/null || echo "")
if [ -n "$USER_POOL_ID" ] && [ "$USER_POOL_ID" != "None" ]; then
  echo "  Cognito User Pool: $USER_POOL_ID"
  echo "  Save this for step 04 (Cognito auth setup)"
else
  echo "  [WARN] Could not find Cognito User Pool. Check CcOnBedrock-Security stack outputs."
fi

echo ""
echo "Base stacks deployed successfully."
echo ""
echo "Next: ./04-setup-cognito-auth.sh"
