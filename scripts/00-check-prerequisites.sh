#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Prerequisite Checker
# Validates all tools, credentials, and AWS service access needed before deployment.
#
# Usage: ./00-check-prerequisites.sh

REGION="${AWS_REGION:-ap-northeast-2}"
ERRORS=0
WARNINGS=0

header() { echo -e "\n\033[1;36m=== $1 ===\033[0m"; }
ok()     { echo -e "  \033[32m[OK]\033[0m $1"; }
warn()   { echo -e "  \033[33m[WARN]\033[0m $1"; WARNINGS=$((WARNINGS + 1)); }
fail()   { echo -e "  \033[31m[FAIL]\033[0m $1"; ERRORS=$((ERRORS + 1)); }

header "1. Required CLI Tools"

for cmd in aws node npm npx docker git jq; do
  if command -v "$cmd" &>/dev/null; then
    ver=$($cmd --version 2>&1 | head -1)
    ok "$cmd ($ver)"
  else
    fail "$cmd not found"
  fi
done

# CDK check (npx or global)
if npx cdk --version &>/dev/null 2>&1; then
  ok "cdk ($(npx cdk --version 2>/dev/null))"
else
  fail "AWS CDK not installed. Run: npm install -g aws-cdk"
fi

header "2. AWS Credentials"

if aws sts get-caller-identity &>/dev/null; then
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  ARN=$(aws sts get-caller-identity --query Arn --output text)
  ok "Account: $ACCOUNT_ID"
  ok "Identity: $ARN"
  ok "Region: $REGION"
else
  fail "AWS credentials not configured. Run: aws configure"
fi

header "3. AWS Region Configuration"

CONFIGURED_REGION=$(aws configure get region 2>/dev/null || echo "not set")
if [ "$CONFIGURED_REGION" = "$REGION" ]; then
  ok "Default region matches: $REGION"
else
  warn "Default region is '$CONFIGURED_REGION', expected '$REGION'. Set AWS_REGION or run: aws configure set region $REGION"
fi

header "4. Bedrock Model Access"

for MODEL_ID in anthropic.claude-sonnet-4-6-v1 anthropic.claude-opus-4-6-v1; do
  if aws bedrock get-foundation-model --model-identifier "$MODEL_ID" --region "$REGION" &>/dev/null 2>&1; then
    ok "Bedrock model: $MODEL_ID"
  else
    warn "Bedrock model '$MODEL_ID' not accessible. Enable via AWS Console > Bedrock > Model Access"
  fi
done

header "5. Route 53 Hosted Zone"

DOMAIN_NAME="${DOMAIN_NAME:-atomai.click}"
HZ_COUNT=$(aws route53 list-hosted-zones-by-name \
  --dns-name "$DOMAIN_NAME" \
  --query "HostedZones[?Name=='${DOMAIN_NAME}.'] | length(@)" \
  --output text 2>/dev/null || echo "0")
if [ "$HZ_COUNT" != "0" ]; then
  HZ_ID=$(aws route53 list-hosted-zones-by-name \
    --dns-name "$DOMAIN_NAME" \
    --query "HostedZones[?Name=='${DOMAIN_NAME}.'].Id" \
    --output text | sed 's|/hostedzone/||')
  ok "Hosted Zone: $DOMAIN_NAME ($HZ_ID)"
  echo "    Use this in CDK: -c hostedZoneId=$HZ_ID"
else
  warn "No Route 53 hosted zone for '$DOMAIN_NAME'. Create one or set DOMAIN_NAME env var"
fi

header "6. Docker Buildx (ARM64 cross-platform)"

if docker buildx ls 2>/dev/null | grep -q "multibuilder"; then
  ok "Docker buildx 'multibuilder' exists"
else
  warn "Docker buildx 'multibuilder' not found. Create: docker buildx create --name multibuilder --use"
fi

if docker info &>/dev/null 2>&1; then
  ok "Docker daemon running"
else
  fail "Docker daemon not running. Start: sudo systemctl start docker"
fi

header "7. Node.js Version"

NODE_VER=$(node --version 2>/dev/null || echo "none")
REQUIRED_MAJOR=20
ACTUAL_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
if [ "$ACTUAL_MAJOR" -ge "$REQUIRED_MAJOR" ] 2>/dev/null; then
  ok "Node.js $NODE_VER (>= v${REQUIRED_MAJOR} required)"
else
  warn "Node.js $NODE_VER found, v${REQUIRED_MAJOR}+ recommended"
fi

header "8. CDK Dependencies"

CDK_DIR="$(cd "$(dirname "$0")/../cdk" && pwd)"
if [ -d "$CDK_DIR/node_modules" ]; then
  ok "CDK node_modules exists"
else
  warn "CDK dependencies not installed. Run: cd cdk && npm install"
fi

header "Summary"
echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo -e "\033[31m$ERRORS error(s), $WARNINGS warning(s). Fix errors before proceeding.\033[0m"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo -e "\033[33m0 errors, $WARNINGS warning(s). Review warnings, but you can proceed.\033[0m"
else
  echo -e "\033[32mAll checks passed! Proceed to: ./01-create-ecr-repos.sh\033[0m"
fi
