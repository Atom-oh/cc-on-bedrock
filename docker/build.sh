#!/bin/bash
set -euo pipefail

# Usage: ./build.sh [build|push|all] [devenv-ubuntu|devenv-al2023|dashboard|litellm|all]
ACTION="${1:-build}"
TARGET="${2:-all}"
REGION="${AWS_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "000000000000")
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${IMAGE_TAG:-latest}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

build_image() {
  local name="$1"
  local dockerfile="$2"
  local context="$3"
  local ecr_repo="$4"
  local image_tag="$5"

  echo "=== Building $name (tag: $image_tag) ==="
  docker buildx build \
    --builder multibuilder \
    --platform linux/arm64 \
    -f "$dockerfile" \
    -t "${ecr_repo}:${image_tag}" \
    -t "${ECR_REGISTRY}/${ecr_repo}:${image_tag}" \
    --load \
    "$context"
  echo "=== Built $name ==="
}

push_image() {
  local ecr_repo="$1"
  local image_tag="$2"

  echo "=== Pushing $ecr_repo:$image_tag ==="
  aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "$ECR_REGISTRY"
  docker push "${ECR_REGISTRY}/${ecr_repo}:${image_tag}"
  echo "=== Pushed $ecr_repo:$image_tag ==="
}

# Build targets
do_build() {
  case "$TARGET" in
    devenv-ubuntu)
      build_image "devenv-ubuntu" "$SCRIPT_DIR/devenv/Dockerfile.ubuntu" "$SCRIPT_DIR/devenv" "cc-on-bedrock/devenv" "ubuntu-${TAG}" ;;
    devenv-al2023)
      build_image "devenv-al2023" "$SCRIPT_DIR/devenv/Dockerfile.al2023" "$SCRIPT_DIR/devenv" "cc-on-bedrock/devenv" "al2023-${TAG}" ;;
    dashboard)
      build_image "dashboard" "$SCRIPT_DIR/dashboard/Dockerfile" "$PROJECT_ROOT" "cc-on-bedrock/dashboard" "$TAG" ;;
    litellm)
      build_image "litellm" "$SCRIPT_DIR/litellm/Dockerfile" "$SCRIPT_DIR/litellm" "cc-on-bedrock/litellm" "$TAG" ;;
    all)
      build_image "devenv-ubuntu" "$SCRIPT_DIR/devenv/Dockerfile.ubuntu" "$SCRIPT_DIR/devenv" "cc-on-bedrock/devenv" "ubuntu-${TAG}"
      build_image "devenv-al2023" "$SCRIPT_DIR/devenv/Dockerfile.al2023" "$SCRIPT_DIR/devenv" "cc-on-bedrock/devenv" "al2023-${TAG}"
      build_image "dashboard" "$SCRIPT_DIR/dashboard/Dockerfile" "$PROJECT_ROOT" "cc-on-bedrock/dashboard" "$TAG"
      build_image "litellm" "$SCRIPT_DIR/litellm/Dockerfile" "$SCRIPT_DIR/litellm" "cc-on-bedrock/litellm" "$TAG"
      ;;
  esac
}

do_push() {
  case "$TARGET" in
    devenv-ubuntu)
      push_image "cc-on-bedrock/devenv" "ubuntu-${TAG}" ;;
    devenv-al2023)
      push_image "cc-on-bedrock/devenv" "al2023-${TAG}" ;;
    dashboard)
      push_image "cc-on-bedrock/dashboard" "$TAG" ;;
    litellm)
      push_image "cc-on-bedrock/litellm" "$TAG" ;;
    all)
      push_image "cc-on-bedrock/devenv" "ubuntu-${TAG}"
      push_image "cc-on-bedrock/devenv" "al2023-${TAG}"
      push_image "cc-on-bedrock/dashboard" "$TAG"
      push_image "cc-on-bedrock/litellm" "$TAG"
      ;;
  esac
}

case "$ACTION" in
  build) do_build ;;
  push) do_push ;;
  all) do_build && do_push ;;
  *) echo "Usage: $0 [build|push|all] [devenv-ubuntu|devenv-al2023|dashboard|litellm|all]"; exit 1 ;;
esac

echo "=== Done ==="
