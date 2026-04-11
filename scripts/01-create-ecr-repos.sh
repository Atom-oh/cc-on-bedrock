#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Create ECR Repositories
# Creates required ECR repos with encryption and scan-on-push.
# Safe to re-run (skips existing repos).
#
# Usage: ./01-create-ecr-repos.sh

REGION="${AWS_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

REPOS=(
  "cc-on-bedrock/devenv"
  "cc-on-bedrock/dashboard"
  "cc-on-bedrock/nginx"
)

echo "=== Creating ECR Repositories ==="
echo "Region: $REGION"
echo "Account: $ACCOUNT_ID"
echo ""

for REPO in "${REPOS[@]}"; do
  if aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" &>/dev/null; then
    echo "  [EXISTS] $REPO"
  else
    aws ecr create-repository \
      --repository-name "$REPO" \
      --region "$REGION" \
      --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=KMS \
      --output text --query 'repository.repositoryUri'
    echo "  [CREATED] $REPO"
  fi
done

# Set lifecycle policy (keep last 10 images)
LIFECYCLE_POLICY='{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep last 10 images",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": { "type": "expire" }
    }
  ]
}'

echo ""
echo "Setting lifecycle policy (keep last 10 images)..."
for REPO in "${REPOS[@]}"; do
  aws ecr put-lifecycle-policy \
    --repository-name "$REPO" \
    --lifecycle-policy-text "$LIFECYCLE_POLICY" \
    --region "$REGION" &>/dev/null || true
  echo "  $REPO - lifecycle set"
done

echo ""
echo "ECR Registry: ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
echo ""
echo "Next: ./02-cdk-bootstrap.sh"
