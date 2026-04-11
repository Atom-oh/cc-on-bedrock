#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Build DevEnv AMIs
# Wrapper that builds AMIs for each supported OS type.
# The actual build logic is in build-ami.sh.
#
# Usage: ./07-build-ami.sh [ubuntu|al2023|all]
# Default: all (builds both Ubuntu and AL2023 AMIs)

TARGET="${1:-all}"
INSTANCE_TYPE="${2:-t4g.medium}"
VOLUME_SIZE="${3:-30}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Build DevEnv AMIs ==="
echo "Target: $TARGET"
echo "Instance type: $INSTANCE_TYPE"
echo "Volume size: ${VOLUME_SIZE}GB"
echo ""

if [ "$TARGET" != "ubuntu" ] && [ "$TARGET" != "al2023" ] && [ "$TARGET" != "all" ]; then
  echo "ERROR: Target must be 'ubuntu', 'al2023', or 'all'"
  exit 1
fi

build_ami() {
  local os_type="$1"
  echo "--- Building $os_type AMI ---"
  bash "$SCRIPT_DIR/build-ami.sh" "$os_type" "$INSTANCE_TYPE" "$VOLUME_SIZE"
  echo ""
}

if [ "$TARGET" = "all" ]; then
  build_ami "ubuntu"
  build_ami "al2023"
else
  build_ami "$TARGET"
fi

echo "=== AMI Build Complete ==="
echo ""
echo "Verify AMIs:"
echo "  aws ssm get-parameter --name /cc-on-bedrock/devenv/ami-id/ubuntu --query Parameter.Value --output text"
echo "  aws ssm get-parameter --name /cc-on-bedrock/devenv/ami-id/al2023 --query Parameter.Value --output text"
echo ""
echo "Next: ./08-verify-deployment.sh"
