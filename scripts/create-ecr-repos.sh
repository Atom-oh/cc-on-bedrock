#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
REPOS=("cc-on-bedrock/devenv" "cc-on-bedrock/dashboard" "cc-on-bedrock/litellm")

for REPO in "${REPOS[@]}"; do
  echo "Creating ECR repository: $REPO"
  aws ecr create-repository \
    --repository-name "$REPO" \
    --region "$REGION" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=KMS \
    2>/dev/null || echo "  Repository $REPO already exists"
done

echo "ECR repositories ready."
