#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Deploy Service Stacks
# Deploys remaining CDK stacks in dependency order:
#   UsageTracking, WAF, EC2DevEnv, EcsDevenv, Dashboard
#
# Prerequisites: 03-deploy-base-stacks.sh (Network + Security)
#
# Usage: ./06-deploy-service-stacks.sh [domain-name] [hosted-zone-id]

DOMAIN_NAME="${1:-}"
HOSTED_ZONE_ID="${2:-}"
REGION="${AWS_REGION:-ap-northeast-2}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$SCRIPT_DIR/../cdk"

echo "=== Deploy Service Stacks ==="
echo "Region: $REGION"
echo ""

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

# Stack 03: Usage Tracking (DynamoDB, EventBridge, Lambda)
echo "--- Deploying CcOnBedrock-UsageTracking ---"
npx cdk deploy CcOnBedrock-UsageTracking \
  --require-approval broadening \
  $CTX_ARGS
echo "  UsageTracking deployed"
echo ""

# Stack 06: WAF (us-east-1, required for CloudFront)
echo "--- Deploying CcOnBedrock-WAF (us-east-1) ---"
npx cdk deploy CcOnBedrock-WAF \
  --require-approval broadening \
  $CTX_ARGS
echo "  WAF deployed"
echo ""

# Stack 07: EC2-per-user DevEnv (Launch Template, SG, IAM, DynamoDB)
echo "--- Deploying CcOnBedrock-Ec2Devenv ---"
npx cdk deploy CcOnBedrock-Ec2Devenv \
  --require-approval broadening \
  $CTX_ARGS
echo "  Ec2Devenv deployed"
echo ""

# Stack 04: ECS DevEnv (Cluster, NLB+Nginx, EFS, CloudFront)
echo "--- Deploying CcOnBedrock-EcsDevenv ---"
npx cdk deploy CcOnBedrock-EcsDevenv \
  --require-approval broadening \
  $CTX_ARGS
echo "  EcsDevenv deployed"
echo ""

# Stack 05: Dashboard (EC2 ASG, ALB, CloudFront)
echo "--- Deploying CcOnBedrock-Dashboard ---"
npx cdk deploy CcOnBedrock-Dashboard \
  --require-approval broadening \
  $CTX_ARGS
echo "  Dashboard deployed"
echo ""

echo "=== All Service Stacks Deployed ==="
echo ""
echo "Stack deployment order completed:"
echo "  1. Network       (03-deploy-base-stacks.sh)"
echo "  2. Security       (03-deploy-base-stacks.sh)"
echo "  3. UsageTracking  (this script)"
echo "  4. WAF            (this script)"
echo "  5. Ec2Devenv      (this script)"
echo "  6. EcsDevenv      (this script)"
echo "  7. Dashboard      (this script)"
echo ""
echo "Next: ./07-build-ami.sh"
