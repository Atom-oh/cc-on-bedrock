#!/usr/bin/env bash
###############################################################################
# destroy.sh - Destroy CC-on-Bedrock CloudFormation stacks in reverse order
#
# Usage:
#   ./destroy.sh                  # destroy all stacks
#   ./destroy.sh --region us-east-1
###############################################################################
set -euo pipefail

STACK_PREFIX="cc-on-bedrock"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    *)        echo "Unknown option: $1"; exit 1 ;;
  esac
done

STACKS=(
  "${STACK_PREFIX}-dashboard"
  "${STACK_PREFIX}-ecs-devenv"
  "${STACK_PREFIX}-security"
  "${STACK_PREFIX}-network"
)

echo "============================================================"
echo "  CC-on-Bedrock CloudFormation Teardown"
echo "  Region: ${REGION}"
echo "============================================================"
echo ""
echo "WARNING: This will destroy ALL CC-on-Bedrock stacks:"
for s in "${STACKS[@]}"; do
  echo "  - ${s}"
done
echo ""
echo "Resources with DeletionPolicy Retain (ECR repos, EFS, RDS snapshots)"
echo "will NOT be deleted automatically."
echo ""
read -rp "Are you sure? Type 'yes' to confirm: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

echo ""

delete_stack() {
  local stack_name="$1"
  local idx="$2"
  local total="$3"

  echo "[${idx}/${total}] Deleting ${stack_name}..."

  # Check if stack exists
  if ! aws cloudformation describe-stacks --stack-name "$stack_name" --region "$REGION" &>/dev/null; then
    echo "  [SKIP] Stack ${stack_name} does not exist."
    return 0
  fi

  aws cloudformation delete-stack \
    --stack-name "$stack_name" \
    --region "$REGION"

  echo "  Waiting for stack deletion..."
  aws cloudformation wait stack-delete-complete \
    --stack-name "$stack_name" \
    --region "$REGION"

  echo "  [OK] ${stack_name} deleted."
}

TOTAL=${#STACKS[@]}
for i in "${!STACKS[@]}"; do
  delete_stack "${STACKS[$i]}" "$((i + 1))" "$TOTAL"
  echo ""
done

echo "============================================================"
echo "  Teardown complete!"
echo "============================================================"
echo ""
echo "NOTE: The following resources may still exist (DeletionPolicy Retain):"
echo "  - ECR repository: cc-on-bedrock/devenv"
echo "  - EFS file system"
echo ""
