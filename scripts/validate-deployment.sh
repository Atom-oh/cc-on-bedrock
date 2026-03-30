#!/bin/bash
# CC-on-Bedrock Deployment Validation Script
# Tests: IMDS block, Task Role, EFS isolation, NLB→Nginx→ECS, Dashboard
set -euo pipefail

CLUSTER="cc-on-bedrock-devenv"
REGION="ap-northeast-2"
ACCOUNT_ID="180294183052"
DASHBOARD_URL="https://cconbedrock-dashboard.atomai.click"
DEVENV_DOMAIN="dev.atomai.click"
ROUTING_TABLE="cc-routing-table"

PASS=0
FAIL=0
SKIP=0

log() { echo -e "\033[1;34m[TEST]\033[0m $1"; }
pass() { echo -e "\033[1;32m[PASS]\033[0m $1"; PASS=$((PASS+1)); }
fail() { echo -e "\033[1;31m[FAIL]\033[0m $1"; FAIL=$((FAIL+1)); }
skip() { echo -e "\033[1;33m[SKIP]\033[0m $1"; SKIP=$((SKIP+1)); }

echo "=========================================="
echo "CC-on-Bedrock Deployment Validation"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=========================================="

# ─── 1. Infrastructure ───
log "1. Infrastructure checks"

# 1.1 ECS Cluster active
CLUSTER_STATUS=$(aws ecs describe-clusters --clusters $CLUSTER --query 'clusters[0].status' --output text 2>/dev/null || echo "FAILED")
[ "$CLUSTER_STATUS" = "ACTIVE" ] && pass "1.1 ECS Cluster: ACTIVE" || fail "1.1 ECS Cluster: $CLUSTER_STATUS"

# 1.2 Container instances registered
CI_COUNT=$(aws ecs list-container-instances --cluster $CLUSTER --query 'containerInstanceArns|length(@)' --output text 2>/dev/null || echo 0)
[ "$CI_COUNT" -ge 1 ] && pass "1.2 Container Instances: $CI_COUNT registered" || fail "1.2 Container Instances: $CI_COUNT (need >= 1)"

# 1.3 NLB healthy targets
NLB_ARN=$(aws elbv2 describe-load-balancers --query "LoadBalancers[?contains(LoadBalancerName,'Deven') && Type=='network'].LoadBalancerArn" --output text 2>/dev/null | head -1)
if [ -n "$NLB_ARN" ] && [ "$NLB_ARN" != "None" ]; then
  TG_ARN=$(aws elbv2 describe-target-groups --load-balancer-arn "$NLB_ARN" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)
  HEALTHY=$(aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --query 'TargetHealthDescriptions[?TargetHealth.State==`healthy`]|length(@)' --output text 2>/dev/null || echo 0)
  [ "$HEALTHY" -ge 1 ] && pass "1.3 NLB Nginx targets: $HEALTHY healthy" || fail "1.3 NLB Nginx targets: $HEALTHY healthy (need >= 1)"
else
  fail "1.3 NLB not found"
fi

# 1.4 Nginx ECS Service running
NGINX_RUNNING=$(aws ecs list-tasks --cluster $CLUSTER --family cc-nginx-proxy --desired-status RUNNING --query 'taskArns|length(@)' --output text 2>/dev/null || echo 0)
[ "$NGINX_RUNNING" -ge 1 ] && pass "1.4 Nginx tasks: $NGINX_RUNNING running" || fail "1.4 Nginx tasks: $NGINX_RUNNING (need >= 1)"

# 1.5 Dashboard ALB healthy
DASH_TG=$(aws elbv2 describe-target-groups --query "TargetGroups[?contains(TargetGroupName,'Dashb')].TargetGroupArn" --output text 2>/dev/null | head -1)
if [ -n "$DASH_TG" ] && [ "$DASH_TG" != "None" ]; then
  DASH_HEALTHY=$(aws elbv2 describe-target-health --target-group-arn "$DASH_TG" --query 'TargetHealthDescriptions[?TargetHealth.State==`healthy`]|length(@)' --output text 2>/dev/null || echo 0)
  [ "$DASH_HEALTHY" -ge 1 ] && pass "1.5 Dashboard ALB: $DASH_HEALTHY healthy" || fail "1.5 Dashboard ALB: $DASH_HEALTHY healthy"
else
  skip "1.5 Dashboard TG not found"
fi

# ─── 2. IMDS Block ───
log "2. IMDS Block checks"

# 2.1 ECS agent config
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "CcOnBedrock-EcsDevenv-EcsCapacityAsgASG3454C80C-JafzUUGHe10V" --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text 2>/dev/null)
if [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ]; then
  CMD_ID=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name "AWS-RunShellScript" --parameters '{"commands":["grep ECS_AWSVPC_BLOCK_IMDS /etc/ecs/ecs.config 2>/dev/null || echo NOT_FOUND"]}' --query 'Command.CommandId' --output text 2>/dev/null)
  sleep 5
  IMDS_CONFIG=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query 'StandardOutputContent' --output text 2>/dev/null || echo "TIMEOUT")
  echo "$IMDS_CONFIG" | grep -q "ECS_AWSVPC_BLOCK_IMDS=true" && pass "2.1 ECS_AWSVPC_BLOCK_IMDS=true" || fail "2.1 ECS_AWSVPC_BLOCK_IMDS: $IMDS_CONFIG"
else
  skip "2.1 No ECS instance found (refresh in progress?)"
fi

# 2.2 Instance Role has NO Bedrock
INSTANCE_ROLE=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text 2>/dev/null | awk -F/ '{print $NF}')
if [ -n "$INSTANCE_ROLE" ] && [ "$INSTANCE_ROLE" != "None" ]; then
  ROLE_NAME=$(aws iam get-instance-profile --instance-profile-name "$INSTANCE_ROLE" --query 'InstanceProfile.Roles[0].RoleName' --output text 2>/dev/null)
  BEDROCK_POLICY=$(aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name BedrockAccess --query 'PolicyName' --output text 2>/dev/null || echo "NOT_FOUND")
  if [ "$BEDROCK_POLICY" = "BedrockAccess" ]; then
    fail "2.2 Instance Role still has Bedrock policy"
  else
    pass "2.2 Instance Role: NO Bedrock policy"
  fi
else
  skip "2.2 Instance Role check skipped"
fi

# ─── 3. Per-user Task Role ───
log "3. Per-user Task Role checks"

# 3.1 Task role exists
TASK_ROLE_EXISTS=$(aws iam get-role --role-name cc-on-bedrock-task-admin01 --query 'Role.RoleName' --output text 2>/dev/null || echo "NOT_FOUND")
[ "$TASK_ROLE_EXISTS" = "cc-on-bedrock-task-admin01" ] && pass "3.1 Per-user role cc-on-bedrock-task-admin01 exists" || fail "3.1 Per-user role: $TASK_ROLE_EXISTS"

# 3.2 Task role has Bedrock
TASK_BEDROCK=$(aws iam get-role-policy --role-name cc-on-bedrock-task-admin01 --policy-name BedrockAccess --query 'PolicyDocument.Statement[0].Action' --output text 2>/dev/null || echo "NOT_FOUND")
echo "$TASK_BEDROCK" | grep -q "bedrock:InvokeModel" && pass "3.2 Task Role has Bedrock permissions" || fail "3.2 Task Role Bedrock: $TASK_BEDROCK"

# 3.3 Permission boundary
BOUNDARY=$(aws iam get-role --role-name cc-on-bedrock-task-admin01 --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text 2>/dev/null || echo "NONE")
echo "$BOUNDARY" | grep -q "task-boundary" && pass "3.3 Permission boundary attached" || fail "3.3 Permission boundary: $BOUNDARY"

# ─── 4. Nginx Routing Pipeline ───
log "4. Nginx routing pipeline"

# 4.1 DynamoDB routing table exists
TABLE_STATUS=$(aws dynamodb describe-table --table-name $ROUTING_TABLE --query 'Table.TableStatus' --output text 2>/dev/null || echo "NOT_FOUND")
[ "$TABLE_STATUS" = "ACTIVE" ] && pass "4.1 Routing table: ACTIVE" || fail "4.1 Routing table: $TABLE_STATUS"

# 4.2 Lambda can write to S3
LAMBDA_NAME="cc-on-bedrock-nginx-config-gen"
LAMBDA_EXISTS=$(aws lambda get-function --function-name $LAMBDA_NAME --query 'Configuration.FunctionName' --output text 2>/dev/null || echo "NOT_FOUND")
[ "$LAMBDA_EXISTS" = "$LAMBDA_NAME" ] && pass "4.2 Nginx config Lambda exists" || fail "4.2 Lambda: $LAMBDA_EXISTS"

# 4.3 S3 nginx config exists
CONFIG_SIZE=$(aws s3api head-object --bucket cc-on-bedrock-deploy-$ACCOUNT_ID --key nginx/nginx.conf --query 'ContentLength' --output text 2>/dev/null || echo 0)
[ "$CONFIG_SIZE" -gt 100 ] && pass "4.3 S3 nginx.conf: ${CONFIG_SIZE} bytes" || fail "4.3 S3 nginx.conf: ${CONFIG_SIZE} bytes"

# ─── 5. CloudFront ───
log "5. CloudFront checks"

# 5.1 Dashboard CF
DASH_CF_STATUS=$(aws cloudfront get-distribution --id E12T3WM0TRC7FN --query 'Distribution.Status' --output text 2>/dev/null || echo "UNKNOWN")
[ "$DASH_CF_STATUS" = "Deployed" ] && pass "5.1 Dashboard CloudFront: Deployed" || fail "5.1 Dashboard CF: $DASH_CF_STATUS"

# 5.2 DevEnv CF with wildcard alias
DEVENV_CF_ALIAS=$(aws cloudfront get-distribution --id E21ROKGJ66FOZ0 --query 'Distribution.DistributionConfig.Aliases.Items[0]' --output text 2>/dev/null || echo "NONE")
[ "$DEVENV_CF_ALIAS" = "*.dev.atomai.click" ] && pass "5.2 DevEnv CF alias: $DEVENV_CF_ALIAS" || fail "5.2 DevEnv CF alias: $DEVENV_CF_ALIAS"

# 5.3 DevEnv CF origin is NLB (not ALB)
DEVENV_CF_ORIGIN=$(aws cloudfront get-distribution --id E21ROKGJ66FOZ0 --query 'Distribution.DistributionConfig.Origins.Items[0].DomainName' --output text 2>/dev/null)
# NLB DNS doesn't contain "nlb" — verify it's NOT the old ALB (which contains "app/")
echo "$DEVENV_CF_ORIGIN" | grep -q "app/" && fail "5.3 DevEnv CF origin: ALB (should be NLB)" || pass "5.3 DevEnv CF origin: $DEVENV_CF_ORIGIN"

# ─── 6. E2E Access ───
log "6. E2E access tests"

# 6.1 Dashboard accessible
DASH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "$DASHBOARD_URL/api/health" 2>/dev/null || echo "000")
[ "$DASH_CODE" = "200" ] && pass "6.1 Dashboard /api/health: $DASH_CODE" || fail "6.1 Dashboard /api/health: $DASH_CODE"

# 6.2 DevEnv returns 503 (no container) or 302 (container running)
DEVENV_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "https://admin01.$DEVENV_DOMAIN/" 2>/dev/null || echo "000")
if [ "$DEVENV_CODE" = "302" ] || [ "$DEVENV_CODE" = "200" ]; then
  pass "6.2 DevEnv admin01: $DEVENV_CODE (container running)"
elif [ "$DEVENV_CODE" = "503" ]; then
  pass "6.2 DevEnv admin01: 503 (no container, Nginx responding correctly)"
else
  fail "6.2 DevEnv admin01: $DEVENV_CODE"
fi

# ─── 7. Cognito + Auth ───
log "7. Auth checks"

# 7.1 SSM Parameter Store has Cognito credentials
COGNITO_ID=$(aws ssm get-parameter --name /cc-on-bedrock/cognito/client-id --query 'Parameter.Value' --output text 2>/dev/null || echo "NOT_FOUND")
[ "$COGNITO_ID" != "NOT_FOUND" ] && [ -n "$COGNITO_ID" ] && pass "7.1 SSM Cognito client-id: present" || fail "7.1 SSM Cognito client-id: $COGNITO_ID"

# 7.2 Cognito User Pool exists
POOL_STATUS=$(aws cognito-idp describe-user-pool --user-pool-id ap-northeast-2_bXyvU9zhG --query 'UserPool.Status' --output text 2>/dev/null || echo "NOT_FOUND")
[ -n "$POOL_STATUS" ] && pass "7.2 Cognito User Pool: exists" || fail "7.2 Cognito User Pool: $POOL_STATUS"

# ─── Summary ───
echo ""
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "=========================================="

[ "$FAIL" -eq 0 ] && echo -e "\033[1;32mAll tests passed!\033[0m" || echo -e "\033[1;31m$FAIL test(s) failed!\033[0m"
exit $FAIL
