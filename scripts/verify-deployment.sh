#!/usr/bin/env bash
###############################################################################
# verify-deployment.sh — Verify CC-on-Bedrock EC2-per-user deployment
#
# Checks: CloudFront, ECS (Dashboard+Nginx), DynamoDB, Cognito, ECR, SSM,
#          Lambda, IAM, EC2 DevEnv AMI, Bedrock access
#
# Usage: ./verify-deployment.sh <domain-name> [--region <region>]
###############################################################################
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <domain-name> [--region <region>]"
  echo "Example: $0 atomai.click"
  exit 1
fi

DOMAIN="$1"; shift
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
pass() { PASS=$((PASS+1)); echo "  ✅ ${1:-OK}"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ ${1:-FAIL}"; }
warn() { WARN=$((WARN+1)); echo "  ⚠️  ${1:-WARNING}"; }
check() { echo "  🔍 $1"; }

echo "================================================================="
echo " CC-on-Bedrock Deployment Verification"
echo " Domain: $DOMAIN | Region: $REGION"
echo "================================================================="
echo ""

# 1. CloudFront
echo "[CloudFront]"
check "CloudFront distributions exist"
CF_COUNT=$(aws cloudfront list-distributions --query "DistributionList.Items[?contains(Aliases.Items || [''], '${DOMAIN}')]|length(@)" --output text 2>/dev/null || echo "0")
if [[ "$CF_COUNT" -gt 0 ]]; then pass "$CF_COUNT distribution(s) for $DOMAIN"; else fail "no distributions found"; fi

check "Dashboard HTTPS reachable"
HTTP_CODE=$(curl -sLo /dev/null -w '%{http_code}' --max-time 10 "https://cconbedrock-dashboard.${DOMAIN}/api/health" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then pass "HTTP $HTTP_CODE"; elif [[ "$HTTP_CODE" == "000" ]]; then fail "connection failed"; else warn "HTTP $HTTP_CODE"; fi
echo ""

# 2. ECS
echo "[ECS]"
CLUSTER="cc-on-bedrock-devenv"
check "ECS cluster exists"
CLUSTER_STATUS=$(aws ecs describe-clusters --clusters "$CLUSTER" --region "$REGION" --query "clusters[0].status" --output text 2>/dev/null || echo "MISSING")
if [[ "$CLUSTER_STATUS" == "ACTIVE" ]]; then pass "$CLUSTER is ACTIVE"; else fail "cluster status=$CLUSTER_STATUS"; fi

for SVC_PATTERN in "Dashboard" "Nginx"; do
  SVC=$(aws ecs list-services --cluster "$CLUSTER" --region "$REGION" --query "serviceArns[?contains(@, '$SVC_PATTERN')]|[0]" --output text 2>/dev/null || echo "")
  check "ECS $SVC_PATTERN service running"
  if [[ -n "$SVC" && "$SVC" != "None" ]]; then
    RUNNING=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" --query "services[0].runningCount" --output text 2>/dev/null || echo "0")
    DESIRED=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" --query "services[0].desiredCount" --output text 2>/dev/null || echo "0")
    if [[ "$RUNNING" -ge "$DESIRED" && "$DESIRED" -gt 0 ]]; then pass "$RUNNING/$DESIRED tasks"; else warn "$RUNNING/$DESIRED tasks"; fi
  else
    fail "service not found"
  fi
done
echo ""

# 3. DynamoDB
echo "[DynamoDB]"
for TABLE in "cc-on-bedrock-usage" "cc-user-instances" "cc-routing-table" "cc-department-budgets"; do
  check "Table $TABLE exists"
  STATUS=$(aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" --query "Table.TableStatus" --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$STATUS" == "ACTIVE" ]]; then pass; else fail "status=$STATUS"; fi
done
echo ""

# 4. Cognito
echo "[Cognito]"
check "User pool exists"
POOL_ID=$(aws cognito-idp list-user-pools --max-results 20 --region "$REGION" \
  --query "UserPools[?contains(Name,'cc-on-bedrock')].Id|[0]" --output text 2>/dev/null || echo "")
if [[ -n "$POOL_ID" && "$POOL_ID" != "None" ]]; then
  USER_COUNT=$(aws cognito-idp list-users --user-pool-id "$POOL_ID" --region "$REGION" --query "Users|length(@)" --output text 2>/dev/null || echo "0")
  pass "pool=$POOL_ID users=$USER_COUNT"
else
  fail "user pool not found"
fi
echo ""

# 5. ECR
echo "[ECR]"
for REPO in "cc-on-bedrock/dashboard" "cc-on-bedrock/devenv"; do
  check "ECR repo $REPO"
  IMG_COUNT=$(aws ecr describe-images --repository-name "$REPO" --region "$REGION" --query "imageDetails|length(@)" --output text 2>/dev/null || echo "0")
  if [[ "$IMG_COUNT" -gt 0 ]]; then pass "$IMG_COUNT images"; else warn "empty or not found"; fi
done
echo ""

# 6. EC2 DevEnv AMI
echo "[EC2 DevEnv AMI]"
for OS in "ubuntu" "al2023"; do
  check "AMI for $OS"
  AMI_ID=$(aws ssm get-parameter --name "/cc-on-bedrock/devenv/ami-id/$OS" --region "$REGION" --query "Parameter.Value" --output text 2>/dev/null || echo "")
  if [[ -n "$AMI_ID" && "$AMI_ID" != "None" ]]; then
    AMI_STATE=$(aws ec2 describe-images --image-ids "$AMI_ID" --region "$REGION" --query "Images[0].State" --output text 2>/dev/null || echo "unknown")
    if [[ "$AMI_STATE" == "available" ]]; then pass "$AMI_ID ($AMI_STATE)"; else warn "$AMI_ID ($AMI_STATE)"; fi
  else
    if [[ "$OS" == "ubuntu" ]]; then fail "AMI not found"; else warn "AMI not found (optional)"; fi
  fi
done
echo ""

# 7. Lambda
echo "[Lambda]"
for FN in "cc-on-bedrock-usage-tracker" "cc-on-bedrock-budget-check" "cc-on-bedrock-nginx-config-gen" "cc-on-bedrock-ec2-idle-stop"; do
  check "Lambda $FN"
  STATE=$(aws lambda get-function --function-name "$FN" --region "$REGION" --query "Configuration.State" --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$STATE" == "Active" ]]; then pass; else fail "state=$STATE"; fi
done
echo ""

# 8. IAM
echo "[IAM]"
check "Permission boundary policy"
BOUNDARY=$(aws iam get-policy --policy-arn "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/cc-on-bedrock-task-boundary" --query "Policy.DefaultVersionId" --output text 2>/dev/null || echo "NOT_FOUND")
if [[ "$BOUNDARY" != "NOT_FOUND" ]]; then pass "version=$BOUNDARY"; else fail "boundary policy not found"; fi
echo ""

# 9. Secrets Manager
echo "[Secrets Manager]"
for SECRET in "cc-on-bedrock/cloudfront-secret"; do
  check "Secret $SECRET"
  STATUS=$(aws secretsmanager describe-secret --secret-id "$SECRET" --region "$REGION" --query "Name" --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$STATUS" != "NOT_FOUND" ]]; then pass; else fail "not found"; fi
done
echo ""

echo "[SSM]"
check "Parameter /cc-on-bedrock/nextauth-secret"
NEXTAUTH_PARAM=$(aws ssm get-parameter --name "/cc-on-bedrock/nextauth-secret" --region "$REGION" --query "Parameter.Name" --output text 2>/dev/null || echo "NOT_FOUND")
if [[ "$NEXTAUTH_PARAM" != "NOT_FOUND" ]]; then pass; else fail "nextauth parameter not found"; fi
echo ""

# 10. Bedrock
echo "[Bedrock Access]"
check "Bedrock model access"
MODELS=$(aws bedrock list-foundation-models --region "$REGION" --query "modelSummaries[?contains(modelId,'claude')].modelId" --output text 2>/dev/null | wc -w)
if [[ "$MODELS" -gt 0 ]]; then pass "$MODELS Claude model(s) accessible"; else fail "no Claude models"; fi

check "Invocation logging enabled"
LOG_CONFIG=$(aws bedrock get-model-invocation-logging-configuration --region "$REGION" --query "loggingConfig.cloudWatchConfig.logGroupName" --output text 2>/dev/null || echo "")
if [[ -n "$LOG_CONFIG" && "$LOG_CONFIG" != "None" ]]; then pass "logGroup=$LOG_CONFIG"; else warn "logging not configured"; fi
echo ""

# Summary
echo "================================================================="
echo " Results: ✅ $PASS passed | ❌ $FAIL failed | ⚠️  $WARN warnings"
echo "================================================================="
[[ "$FAIL" -eq 0 ]] && echo " 🎉 All critical checks passed!" || echo " ⛔ $FAIL critical check(s) failed"
exit "$FAIL"
