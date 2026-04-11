#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: CDK Bootstrap
# Bootstraps CDK in the primary region AND us-east-1 (required for WAF/CloudFront).
# Installs CDK npm dependencies as well.
#
# Usage: ./02-cdk-bootstrap.sh

REGION="${AWS_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$SCRIPT_DIR/../cdk"

echo "=== CDK Bootstrap ==="
echo "Account: $ACCOUNT_ID"
echo "Primary region: $REGION"
echo ""

# Install CDK dependencies
echo "Installing CDK dependencies..."
cd "$CDK_DIR"
npm install --silent
echo "  Dependencies installed"
echo ""

# Bootstrap primary region
echo "Bootstrapping $REGION..."
npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}" \
  --toolkit-stack-name CDKToolkit \
  --qualifier hnb659fds
echo "  $REGION bootstrapped"

# Bootstrap us-east-1 for WAF stack (CloudFront requires us-east-1 WebACL)
if [ "$REGION" != "us-east-1" ]; then
  echo ""
  echo "Bootstrapping us-east-1 (required for WAF/CloudFront)..."
  npx cdk bootstrap "aws://${ACCOUNT_ID}/us-east-1" \
    --toolkit-stack-name CDKToolkit \
    --qualifier hnb659fds
  echo "  us-east-1 bootstrapped"
fi

# Verify synthesis
echo ""
echo "Verifying CDK synthesis..."
npx cdk synth --all --quiet 2>/dev/null && echo "  Synthesis OK" || {
  echo "  [WARN] Synthesis failed. This may be OK if Route 53 or ACM context is missing."
  echo "  You can set context: npx cdk deploy -c hostedZoneId=ZXXXXX -c domainName=example.com"
}

echo ""
echo "Next: ./03-deploy-base-stacks.sh"
