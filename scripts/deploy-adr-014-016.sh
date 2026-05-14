#!/usr/bin/env bash
# Deploy script for ADR-014 (Local Governance) + ADR-016 (CloudFront split)
#
# Run this from the repo root with AWS credentials set.
# Build phase only — does NOT consider operational impact (DNS outage, edge propagation).

set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:-180294183052}"
REGION="${REGION:-ap-northeast-2}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-Z01703432E9KT1G1FIRFM}"
DEVENV_CF_ID="${DEVENV_CF_ID:-E1ZJ5UWCRSNA9D}"
OLD_EDGE_STACK="${OLD_EDGE_STACK:-edge-lambda-stack-c898002f995e43bf22649f20f1b49ce005a2a388e0}"
DASHBOARD_SERVICE="${DASHBOARD_SERVICE:-CcOnBedrock-Dashboard-DashboardSvcService607C5919-6YUFqXVEqA77}"
ECS_CLUSTER="${ECS_CLUSTER:-cc-on-bedrock-devenv}"

export CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}"
export CDK_DEFAULT_REGION="${REGION}"

say() { printf '\n\033[1;36m===\033[0m %s\n' "$*"; }

cd "$(dirname "$0")/../cdk"

# ─── Phase 0: Wait for E1ZJ5UWCRSNA9D disable to complete ────────────
say "Phase 0.1: wait for E1ZJ5UWCRSNA9D disable propagation (~15 min)"
while true; do
  out=$(aws cloudfront get-distribution --id "$DEVENV_CF_ID" 2>&1) || true
  if echo "$out" | grep -q "NoSuchDistribution"; then
    echo "CF $DEVENV_CF_ID does not exist (already deleted or never existed) — skipping wait"
    break
  fi
  status=$(echo "$out" | jq -r '.Distribution.Status // empty' 2>/dev/null || echo "")
  enabled=$(echo "$out" | jq -r '.Distribution.DistributionConfig.Enabled // empty' 2>/dev/null || echo "")
  echo "  status=$status enabled=$enabled"
  [[ "$status" == "Deployed" && "$enabled" == "false" ]] && break
  sleep 30
done

say "Phase 0.2: delete E1ZJ5UWCRSNA9D"
if aws cloudfront get-distribution --id "$DEVENV_CF_ID" >/dev/null 2>&1; then
  etag=$(aws cloudfront get-distribution --id "$DEVENV_CF_ID" --query 'ETag' --output text)
  aws cloudfront delete-distribution --id "$DEVENV_CF_ID" --if-match "$etag"
else
  echo "  already deleted, skipping"
fi

say "Phase 0.3: delete Route 53 *.dev wildcard (if exists)"
record_json=$(aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
  --query "ResourceRecordSets[?Name == '\\\\052.dev.atomai.click.']" --output json)
if [[ $(echo "$record_json" | jq 'length') -gt 0 ]]; then
  echo "$record_json" | jq '{Changes:[{Action:"DELETE",ResourceRecordSet:.[0]}]}' > /tmp/r53-delete.json
  aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch file:///tmp/r53-delete.json
  echo "  *.dev.atomai.click wildcard deleted"
else
  echo "  no *.dev wildcard present, skipping"
fi

# NOTE: orphan edge-lambda-stack deletion is deferred to Phase 5 — Stack 04's
# CURRENT deployed state has a Custom Resource that reads the SSM param owned
# by the orphan stack. Delete it only AFTER Stack 04 redeploy removes the
# Custom Resource.

# ─── Phase 1: Safe additive CDK deploys (no cross-stack export drops) ────
say "Phase 1.1: deploy Stack 03 (UsageTracking) — Stream + budget-check extension"
npx cdk deploy CcOnBedrock-UsageTracking --exclusively --require-approval never

say "Phase 1.2: deploy Stack 08 (LocalGovernance) — NEW stack"
npx cdk deploy CcOnBedrock-LocalGovernance --exclusively --require-approval never

# ─── Phase 2: Resolve cross-stack export chain ─────────────────────
# Order matters: consumer must drop imports before producer can remove exports.
#   Stack 05 imports DevenvEfs/DevenvSg* from Stack 04 → deploy 05 first
#   Stack 04 imports DevEnvAuth* from Stack 02         → deploy 04 second
#   Stack 02 then can finally remove DevEnvAuth exports → deploy 02 last
say "Phase 2.1: deploy Stack 05 (Dashboard — ADR-016 cleanup + ADR-014 env vars) FIRST"
npx cdk deploy CcOnBedrock-Dashboard --exclusively --require-approval never

say "Phase 2.2: deploy Stack 04 (ECS DevEnv + new DevEnv CF + Route 53 *.dev)"
npx cdk deploy CcOnBedrock-EcsDevenv --exclusively --require-approval never

say "Phase 2.3: deploy Stack 02 (Security) — IAM perms + remove orphan DevEnvAuth exports"
npx cdk deploy CcOnBedrock-Security --exclusively --require-approval never

# ─── Phase 4: Dashboard application image push + ECS restart ───────
say "Phase 4.1: build + push Dashboard Docker image"
cd "$(dirname "$0")/../docker"
bash build.sh all dashboard

say "Phase 4.2: force ECS service new deployment"
aws ecs update-service --cluster "$ECS_CLUSTER" --service "$DASHBOARD_SERVICE" --force-new-deployment

say "Wait for ECS deployment to stabilize"
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$DASHBOARD_SERVICE"

# ─── Phase 5: Final cleanup — orphan edge-lambda-stack ─────────────
say "Phase 5: delete orphan edge-lambda-stack (us-east-1)"
# Lambda@Edge replicas may take 1-2 hours to clear; CFN will not block on this.
aws cloudformation delete-stack --region us-east-1 --stack-name "$OLD_EDGE_STACK" || true

echo
echo "Deploy complete. Next: run E2E test"
echo "  bash tests/integration/test-local-governance.sh"
