#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Build and Push Docker Images
# Builds ARM64 images for devenv and dashboard, pushes to ECR.
# Requires ECR repos (01-create-ecr-repos.sh) and Docker buildx.
#
# Usage: ./05-build-docker-images.sh [all|devenv|dashboard]
# Example: ./05-build-docker-images.sh all

TARGET="${1:-all}"
REGION="${AWS_REGION:-ap-northeast-2}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCKER_DIR="$SCRIPT_DIR/../docker"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${IMAGE_TAG:-latest}"

echo "=== Build & Push Docker Images ==="
echo "Target: $TARGET"
echo "ECR: $ECR_REGISTRY"
echo "Tag: $TAG"
echo ""

# Ensure buildx builder exists
if ! docker buildx ls 2>/dev/null | grep -q "multibuilder"; then
  echo "Creating Docker buildx builder..."
  docker buildx create --name multibuilder --use
fi

# ECR login
echo "Authenticating to ECR..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"
echo ""

cd "$DOCKER_DIR"

if [ "$TARGET" = "all" ] || [ "$TARGET" = "devenv" ]; then
  echo "--- Building devenv (Ubuntu 24.04 ARM64) ---"
  bash build.sh all devenv-ubuntu
  echo ""

  echo "--- Building devenv (Amazon Linux 2023 ARM64) ---"
  bash build.sh all devenv-al2023
  echo ""
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "dashboard" ]; then
  echo "--- Building dashboard ---"
  bash build.sh all dashboard
  echo ""
fi

echo "=== Docker Images Ready ==="
echo ""
echo "Verify with:"
echo "  aws ecr list-images --repository-name cc-on-bedrock/devenv --region $REGION"
echo "  aws ecr list-images --repository-name cc-on-bedrock/dashboard --region $REGION"
echo ""
echo "Next: ./06-deploy-service-stacks.sh"
