#!/usr/bin/env bash
###############################################################################
# test-mcp-gateway.sh — ADR-007 Department MCP Gateway E2E Tests
#
# Validates:
#   1. sync-mcp-config.sh script structure and function ordering
#   2. DynamoDB PK pattern consistency across all source files
#   3. Gateway Manager Lambda syntax validation
#   4. CDK synth includes MCP tables + gateway-manager Lambda
#   5. Admin MCP API routes exist
#   6. Dept MCP read-only API exists (RBAC separation)
#   7. Dashboard DDB permissions include MCP tables
#   8. UserData delegates to sync script (no inline MCP sync)
#
# Usage:
#   ./test-mcp-gateway.sh              # run all tests
#   ./test-mcp-gateway.sh --quick      # skip CDK synth (fast)
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

QUICK=false
[[ "${1:-}" == "--quick" ]] && QUICK=true

TOTAL=0
PASS=0
FAIL=0

run_test() {
  local name="$1"
  shift
  TOTAL=$((TOTAL + 1))
  echo -n "  [$TOTAL] $name: "
  if "$@" >/dev/null 2>&1; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
  fi
}

section() {
  echo ""
  echo "════════════════════════════════════════════════════"
  echo "  $1"
  echo "════════════════════════════════════════════════════"
}

# ─── 1. sync-mcp-config.sh Structure ───
section "1. sync-mcp-config.sh Script Validation"

SYNC_SCRIPT="$PROJECT_ROOT/docker/devenv/scripts/sync-mcp-config.sh"

run_test "sync-mcp-config.sh exists and is executable" \
  test -x "$SYNC_SCRIPT"

run_test "write_fallback_config defined before first call" \
  bash -c '
    DEF_LINE=$(grep -n "^write_fallback_config()" "'"$SYNC_SCRIPT"'" | head -1 | cut -d: -f1)
    CALL_LINE=$(grep -n "write_fallback_config$" "'"$SYNC_SCRIPT"'" | head -1 | cut -d: -f1)
    [ -n "$DEF_LINE" ] && [ -n "$CALL_LINE" ] && [ "$DEF_LINE" -lt "$CALL_LINE" ]
  '

run_test "write_fallback_config uses dynamic region (not hardcoded)" \
  bash -c '! grep -q "\"AWS_REGION\": \"ap-northeast-2\"" "'"$SYNC_SCRIPT"'"'

run_test "Uses IMDSv2 token" \
  grep -q "X-aws-ec2-metadata-token-ttl-seconds" "$SYNC_SCRIPT"

run_test "Queries COMMON PK (not DEPT#COMMON)" \
  grep -q '"PK":{"S":"COMMON"}' "$SYNC_SCRIPT"

run_test "bash -n syntax check passes" \
  bash -n "$SYNC_SCRIPT"

# ─── 2. DynamoDB PK Pattern Consistency ───
section "2. DynamoDB PK Pattern Consistency"

run_test "No DEPT#COMMON pattern anywhere in source" \
  bash -c '! grep -rn "DEPT#COMMON" --include="*.ts" --include="*.tsx" --include="*.py" --include="*.sh" "'"$PROJECT_ROOT"'" 2>/dev/null | grep -v node_modules | grep -v ".git/" | grep -v "test-mcp-gateway.sh" | grep -q .'

run_test "Common gateway PK is COMMON in ec2-clients.ts" \
  grep -q '"COMMON".*"GATEWAY"' "$PROJECT_ROOT/shared/nextjs-app/src/lib/ec2-clients.ts"

run_test "Department PK uses DEPT# prefix in ec2-clients.ts" \
  grep -q 'DEPT#\${department}' "$PROJECT_ROOT/shared/nextjs-app/src/lib/ec2-clients.ts"

run_test "cc-dept-mcp-config table name used consistently" \
  bash -c '
    TS_COUNT=$(grep -c "cc-dept-mcp-config" "'"$PROJECT_ROOT"'/shared/nextjs-app/src/lib/ec2-clients.ts" 2>/dev/null || echo 0)
    [ "$TS_COUNT" -ge 1 ]
  '

# ─── 3. Gateway Manager Lambda ───
section "3. Gateway Manager Lambda"

GW_LAMBDA="$PROJECT_ROOT/cdk/lib/lambda/gateway-manager.py"

run_test "gateway-manager.py exists" \
  test -f "$GW_LAMBDA"

run_test "Python syntax valid" \
  python3 -c "import py_compile; py_compile.compile('$GW_LAMBDA', doraise=True)"

run_test "Has lambda_handler entry point" \
  grep -q "def lambda_handler" "$GW_LAMBDA"

run_test "Handles DDB Streams INSERT events" \
  grep -q "INSERT" "$GW_LAMBDA"

run_test "Handles DDB Streams REMOVE events" \
  grep -q "REMOVE" "$GW_LAMBDA"

run_test "Uses bedrock-agentcore-control client" \
  grep -q "bedrock-agentcore-control" "$GW_LAMBDA"

# ─── 4. CDK Infrastructure ───
section "4. CDK Infrastructure (MCP Tables + Lambda)"

CDK_STACK="$PROJECT_ROOT/cdk/lib/03-usage-tracking-stack.ts"

run_test "cc-mcp-catalog table defined in CDK" \
  grep -q "cc-mcp-catalog" "$CDK_STACK"

run_test "cc-dept-mcp-config table defined in CDK" \
  grep -q "cc-dept-mcp-config" "$CDK_STACK"

run_test "Gateway Manager Lambda defined in CDK" \
  grep -q "cc-on-bedrock-gateway-manager" "$CDK_STACK"

run_test "DDB Streams trigger configured" \
  grep -q "DynamoEventSource\|dynamodb.*Stream\|StartingPosition" "$CDK_STACK"

run_test "Gateway Manager DLQ configured" \
  grep -q "gateway-manager-dlq" "$CDK_STACK"

run_test "Permission Boundary includes InvokeGateway" \
  grep -q "InvokeGateway" "$PROJECT_ROOT/cdk/lib/02-security-stack.ts"

if [ "$QUICK" = false ]; then
  run_test "CDK synth succeeds" \
    bash -c "cd '$PROJECT_ROOT/cdk' && npx cdk synth --all --quiet 2>&1"
fi

# ─── 5. Admin MCP API Routes ───
section "5. Admin MCP API Routes"

API_BASE="$PROJECT_ROOT/shared/nextjs-app/src/app/api/admin/mcp"

run_test "Catalog API route exists" \
  test -f "$API_BASE/catalog/route.ts"

run_test "Assignments API route exists" \
  test -f "$API_BASE/assignments/route.ts"

run_test "Gateways API route exists" \
  test -f "$API_BASE/gateways/route.ts"

run_test "Gateways sync API route exists" \
  test -f "$API_BASE/gateways/sync/route.ts"

run_test "Marketplaces API route exists" \
  test -f "$API_BASE/marketplaces/route.ts"

run_test "All admin APIs require isAdmin check" \
  bash -c '
    for f in catalog assignments gateways marketplaces; do
      grep -q "isAdmin" "'"$API_BASE"'/$f/route.ts" || exit 1
    done
  '

# ─── 6. Dept MCP Read-Only API (RBAC Separation) ───
section "6. Dept MCP API (RBAC)"

DEPT_MCP_API="$PROJECT_ROOT/shared/nextjs-app/src/app/api/dept/mcp/route.ts"

run_test "Dept MCP read-only API exists" \
  test -f "$DEPT_MCP_API"

run_test "Dept API checks dept-manager group" \
  grep -q "dept-manager" "$DEPT_MCP_API"

run_test "Dept API does NOT use isAdmin check for read" \
  bash -c '! grep -q "isAdmin.*403\|!.*isAdmin" "'"$DEPT_MCP_API"'"'

run_test "Dept dashboard calls /api/dept/mcp (not /api/admin/)" \
  bash -c '! grep -q "/api/admin/mcp" "'"$PROJECT_ROOT"'/shared/nextjs-app/src/app/dept/dept-dashboard.tsx"'

# ─── 7. Dashboard DDB Permissions ───
section "7. Dashboard Stack DDB Permissions"

DASHBOARD_STACK="$PROJECT_ROOT/cdk/lib/05-dashboard-stack.ts"

run_test "cc-mcp-catalog in dashboard DDB permissions" \
  grep -q "cc-mcp-catalog" "$DASHBOARD_STACK"

run_test "cc-dept-mcp-config in dashboard DDB permissions" \
  grep -q "cc-dept-mcp-config" "$DASHBOARD_STACK"

run_test "cc-department-budgets in dashboard DDB permissions" \
  grep -q "cc-department-budgets" "$DASHBOARD_STACK"

run_test "cc-user-instances in dashboard DDB permissions" \
  grep -q "cc-user-instances" "$DASHBOARD_STACK"

# ─── 8. UserData Delegates to Sync Script ───
section "8. UserData MCP Sync Delegation"

EC2_CLIENTS="$PROJECT_ROOT/shared/nextjs-app/src/lib/ec2-clients.ts"

run_test "UserData calls sync-mcp-config.sh" \
  grep -q "sync-mcp-config.sh" "$EC2_CLIENTS"

run_test "No inline DDB queries in UserData" \
  bash -c '! grep -q "dynamodb get-item.*cc-dept-mcp-config" "'"$EC2_CLIENTS"'"'

run_test "No inline echo JSON construction in UserData" \
  bash -c '! grep -q "echo.*mcp_servers.json\|echo.*awslabs-core-mcp" "'"$EC2_CLIENTS"'"'

run_test "applyGatewayPolicy function exists" \
  grep -q "async function applyGatewayPolicy" "$EC2_CLIENTS"

run_test "applyGatewayPolicy scopes InvokeGateway to specific ARNs" \
  grep -q "Resource: gatewayArns" "$EC2_CLIENTS"

# ─── 9. TypeScript Type Check ───
section "9. TypeScript Validation"

if [ "$QUICK" = false ]; then
  run_test "Next.js TypeScript check passes" \
    bash -c "cd '$PROJECT_ROOT/shared/nextjs-app' && npx tsc --noEmit 2>&1"
fi

# ─── Summary ───
echo ""
echo "════════════════════════════════════════════════════"
echo "  ADR-007 MCP Gateway Test Summary"
echo "════════════════════════════════════════════════════"
echo "  Total: $TOTAL | Pass: $PASS | Fail: $FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ $FAIL test(s) FAILED"
  exit 1
else
  echo "  ✅ All tests passed"
  exit 0
fi
