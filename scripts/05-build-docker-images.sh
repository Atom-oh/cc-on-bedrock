#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Build and Push Docker Images
# Builds ARM64 images for devenv and dashboard, pushes to ECR.
# Requires Docker buildx. Devenv/nginx repos come from 01-create-ecr-repos.sh;
# dashboard repo is Terraform-managed and must be bootstrapped before push.
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

require_repo() {
  local repo="$1"
  if ! aws ecr describe-repositories --repository-names "$repo" --region "$REGION" >/dev/null 2>&1; then
    echo "ERROR: ECR repository '$repo' does not exist in $REGION."
    if [ "$repo" = "cc-on-bedrock/dashboard" ]; then
      echo "Bootstrap the Terraform-managed dashboard repo first:"
      echo "  terraform -chdir=terraform apply -target=module.security.aws_ecr_repository.dashboard"
    else
      echo "Create non-Terraform repos first:"
      echo "  bash scripts/01-create-ecr-repos.sh"
    fi
    exit 1
  fi
}

echo "=== Build & Push Docker Images ==="
echo "Target: $TARGET"
echo "ECR: $ECR_REGISTRY"
echo "Tag: $TAG"
echo ""

if [ "$TARGET" = "all" ] || [ "$TARGET" = "dashboard" ]; then
  require_repo "cc-on-bedrock/dashboard"
fi
if [ "$TARGET" = "all" ] || [ "$TARGET" = "devenv" ]; then
  require_repo "cc-on-bedrock/devenv"
fi

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
echo "Next: terraform -chdir=terraform apply"
