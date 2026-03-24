#!/usr/bin/env bash
###############################################################################
# deploy.sh - Deploy CC-on-Bedrock CloudFormation stacks in sequence
#
# Usage:
#   ./deploy.sh                           # use defaults from params/default.json
#   ./deploy.sh --domain example.org      # override domain name
#   ./deploy.sh --params params/custom.json
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_PREFIX="cc-on-bedrock"
PARAMS_FILE="${SCRIPT_DIR}/params/default.json"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"

# ---------------------------------------------------------------------------
# Parse CLI overrides
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --params)      PARAMS_FILE="$2"; shift 2 ;;
    --region)      REGION="$2"; shift 2 ;;
    --domain)      DOMAIN_OVERRIDE="$2"; shift 2 ;;
    --vpc-cidr)    VPC_CIDR_OVERRIDE="$2"; shift 2 ;;
    *)             echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Load defaults from params JSON file
# ---------------------------------------------------------------------------
if [[ -f "$PARAMS_FILE" ]]; then
  echo "Loading parameters from ${PARAMS_FILE}..."
  VPC_NAME=$(jq -r '.VpcName // "cc-on-bedrock-vpc"' "$PARAMS_FILE")
  VPC_CIDR=$(jq -r '.VpcCidr // "10.0.0.0/16"' "$PARAMS_FILE")
  PUBLIC_SUBNET_CIDR_A=$(jq -r '.PublicSubnetCidrA // "10.0.1.0/24"' "$PARAMS_FILE")
  PUBLIC_SUBNET_CIDR_C=$(jq -r '.PublicSubnetCidrC // "10.0.2.0/24"' "$PARAMS_FILE")
  PRIVATE_SUBNET_CIDR_A=$(jq -r '.PrivateSubnetCidrA // "10.0.16.0/20"' "$PARAMS_FILE")
  PRIVATE_SUBNET_CIDR_C=$(jq -r '.PrivateSubnetCidrC // "10.0.32.0/20"' "$PARAMS_FILE")
  ISOLATED_SUBNET_CIDR_A=$(jq -r '.IsolatedSubnetCidrA // "10.0.100.0/23"' "$PARAMS_FILE")
  ISOLATED_SUBNET_CIDR_C=$(jq -r '.IsolatedSubnetCidrC // "10.0.102.0/23"' "$PARAMS_FILE")
  DOMAIN_NAME=$(jq -r '.DomainName // "example.com"' "$PARAMS_FILE")
  DEV_SUBDOMAIN=$(jq -r '.DevSubdomain // "dev"' "$PARAMS_FILE")
  # LiteLLM removed - Bedrock direct mode
  ECS_HOST_INSTANCE_TYPE=$(jq -r '.EcsHostInstanceType // "m7g.4xlarge"' "$PARAMS_FILE")
  DASHBOARD_INSTANCE_TYPE=$(jq -r '.DashboardInstanceType // "t4g.xlarge"' "$PARAMS_FILE")
  CLOUDFRONT_PREFIX_LIST_ID=$(jq -r '.CloudFrontPrefixListId // "pl-22a6434b"' "$PARAMS_FILE")
else
  echo "Warning: ${PARAMS_FILE} not found. Using built-in defaults."
  VPC_NAME="cc-on-bedrock-vpc"
  VPC_CIDR="10.0.0.0/16"
  PUBLIC_SUBNET_CIDR_A="10.0.1.0/24"
  PUBLIC_SUBNET_CIDR_C="10.0.2.0/24"
  PRIVATE_SUBNET_CIDR_A="10.0.16.0/20"
  PRIVATE_SUBNET_CIDR_C="10.0.32.0/20"
  ISOLATED_SUBNET_CIDR_A="10.0.100.0/23"
  ISOLATED_SUBNET_CIDR_C="10.0.102.0/23"
  DOMAIN_NAME="example.com"
  DEV_SUBDOMAIN="dev"
  # LiteLLM removed - Bedrock direct mode
  ECS_HOST_INSTANCE_TYPE="m7g.4xlarge"
  DASHBOARD_INSTANCE_TYPE="t4g.xlarge"
  CLOUDFRONT_PREFIX_LIST_ID="pl-22a6434b"
fi

# Apply CLI overrides
DOMAIN_NAME="${DOMAIN_OVERRIDE:-$DOMAIN_NAME}"
VPC_CIDR="${VPC_CIDR_OVERRIDE:-$VPC_CIDR}"

# ---------------------------------------------------------------------------
# Helper: get stack output value
# ---------------------------------------------------------------------------
get_output() {
  local stack_name="$1"
  local output_key="$2"
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey==\`${output_key}\`].OutputValue" \
    --output text \
    --region "$REGION"
}

echo "============================================================"
echo "  CC-on-Bedrock CloudFormation Deployment"
echo "  Region: ${REGION}"
echo "  Domain: ${DOMAIN_NAME}"
echo "============================================================"
echo ""

# ===========================================================================
# Stack 01 - Network
# ===========================================================================
echo "[1/4] Deploying ${STACK_PREFIX}-network..."
aws cloudformation deploy \
  --stack-name "${STACK_PREFIX}-network" \
  --template-file "${SCRIPT_DIR}/01-network.yaml" \
  --parameter-overrides \
    VpcName="${VPC_NAME}" \
    VpcCidr="${VPC_CIDR}" \
    PublicSubnetCidrA="${PUBLIC_SUBNET_CIDR_A}" \
    PublicSubnetCidrC="${PUBLIC_SUBNET_CIDR_C}" \
    PrivateSubnetCidrA="${PRIVATE_SUBNET_CIDR_A}" \
    PrivateSubnetCidrC="${PRIVATE_SUBNET_CIDR_C}" \
    IsolatedSubnetCidrA="${ISOLATED_SUBNET_CIDR_A}" \
    IsolatedSubnetCidrC="${ISOLATED_SUBNET_CIDR_C}" \
    DomainName="${DOMAIN_NAME}" \
  --no-fail-on-empty-changeset \
  --region "$REGION"
echo "  [OK] Network stack deployed."

# Retrieve outputs for subsequent stacks
VPC_ID=$(get_output "${STACK_PREFIX}-network" "VpcId")
PUBLIC_SUBNET_A_ID=$(get_output "${STACK_PREFIX}-network" "PublicSubnetAId")
PUBLIC_SUBNET_C_ID=$(get_output "${STACK_PREFIX}-network" "PublicSubnetCId")
PRIVATE_SUBNET_A_ID=$(get_output "${STACK_PREFIX}-network" "PrivateSubnetAId")
PRIVATE_SUBNET_C_ID=$(get_output "${STACK_PREFIX}-network" "PrivateSubnetCId")
ISOLATED_SUBNET_A_ID=$(get_output "${STACK_PREFIX}-network" "IsolatedSubnetAId")
ISOLATED_SUBNET_C_ID=$(get_output "${STACK_PREFIX}-network" "IsolatedSubnetCId")
HOSTED_ZONE_ID=$(get_output "${STACK_PREFIX}-network" "HostedZoneId")

echo ""

# ===========================================================================
# Stack 02 - Security
# ===========================================================================
echo "[2/4] Deploying ${STACK_PREFIX}-security..."
aws cloudformation deploy \
  --stack-name "${STACK_PREFIX}-security" \
  --template-file "${SCRIPT_DIR}/02-security.yaml" \
  --parameter-overrides \
    DomainName="${DOMAIN_NAME}" \
    DevSubdomain="${DEV_SUBDOMAIN}" \
    HostedZoneId="${HOSTED_ZONE_ID}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --region "$REGION"
echo "  [OK] Security stack deployed."

# Retrieve outputs
KMS_KEY_ARN=$(get_output "${STACK_PREFIX}-security" "EncryptionKeyArn")
KMS_KEY_ID=$(get_output "${STACK_PREFIX}-security" "EncryptionKeyId")
USER_POOL_ID=$(get_output "${STACK_PREFIX}-security" "UserPoolId")
USER_POOL_CLIENT_ID=$(get_output "${STACK_PREFIX}-security" "UserPoolClientId")
DEVENV_CERT_ARN=$(get_output "${STACK_PREFIX}-security" "DevEnvCertificateArn")
DASHBOARD_CERT_ARN=$(get_output "${STACK_PREFIX}-security" "DashboardCertificateArn")
CLOUDFRONT_SECRET_ARN=$(get_output "${STACK_PREFIX}-security" "CloudFrontSecretArn")
DASHBOARD_EC2_INSTANCE_PROFILE=$(get_output "${STACK_PREFIX}-security" "DashboardEc2InstanceProfileName")

echo ""

# ===========================================================================
# Stack 03 - ECS DevEnv
# ===========================================================================
echo "[3/4] Deploying ${STACK_PREFIX}-ecs-devenv..."
aws cloudformation deploy \
  --stack-name "${STACK_PREFIX}-ecs-devenv" \
  --template-file "${SCRIPT_DIR}/04-ecs-devenv.yaml" \
  --parameter-overrides \
    VpcId="${VPC_ID}" \
    VpcCidr="${VPC_CIDR}" \
    PublicSubnetAId="${PUBLIC_SUBNET_A_ID}" \
    PublicSubnetCId="${PUBLIC_SUBNET_C_ID}" \
    PrivateSubnetAId="${PRIVATE_SUBNET_A_ID}" \
    PrivateSubnetCId="${PRIVATE_SUBNET_C_ID}" \
    IsolatedSubnetAId="${ISOLATED_SUBNET_A_ID}" \
    IsolatedSubnetCId="${ISOLATED_SUBNET_C_ID}" \
    KmsKeyArn="${KMS_KEY_ARN}" \
    DevEnvCertificateArn="${DEVENV_CERT_ARN}" \
    HostedZoneId="${HOSTED_ZONE_ID}" \
    DomainName="${DOMAIN_NAME}" \
    DevSubdomain="${DEV_SUBDOMAIN}" \
    CloudFrontSecretArn="${CLOUDFRONT_SECRET_ARN}" \
    EcsHostInstanceType="${ECS_HOST_INSTANCE_TYPE}" \
    CloudFrontPrefixListId="${CLOUDFRONT_PREFIX_LIST_ID}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --region "$REGION"
echo "  [OK] ECS DevEnv stack deployed."

echo ""

# ===========================================================================
# Stack 04 - Dashboard
# ===========================================================================
echo "[4/4] Deploying ${STACK_PREFIX}-dashboard..."
aws cloudformation deploy \
  --stack-name "${STACK_PREFIX}-dashboard" \
  --template-file "${SCRIPT_DIR}/05-dashboard.yaml" \
  --parameter-overrides \
    VpcId="${VPC_ID}" \
    VpcCidr="${VPC_CIDR}" \
    PublicSubnetAId="${PUBLIC_SUBNET_A_ID}" \
    PublicSubnetCId="${PUBLIC_SUBNET_C_ID}" \
    PrivateSubnetAId="${PRIVATE_SUBNET_A_ID}" \
    PrivateSubnetCId="${PRIVATE_SUBNET_C_ID}" \
    KmsKeyArn="${KMS_KEY_ARN}" \
    DashboardEc2InstanceProfileName="${DASHBOARD_EC2_INSTANCE_PROFILE}" \
    DashboardCertificateArn="${DASHBOARD_CERT_ARN}" \
    HostedZoneId="${HOSTED_ZONE_ID}" \
    DomainName="${DOMAIN_NAME}" \
    CloudFrontSecretArn="${CLOUDFRONT_SECRET_ARN}" \
    UserPoolId="${USER_POOL_ID}" \
    UserPoolClientId="${USER_POOL_CLIENT_ID}" \
    InstanceType="${DASHBOARD_INSTANCE_TYPE}" \
    CloudFrontPrefixListId="${CLOUDFRONT_PREFIX_LIST_ID}" \
  --no-fail-on-empty-changeset \
  --region "$REGION"
echo "  [OK] Dashboard stack deployed."

echo ""
echo "============================================================"
echo "  Deployment complete!"
echo "============================================================"
echo ""
echo "  Dashboard URL:    https://dashboard.${DOMAIN_NAME}"
echo "  Cognito Pool ID:  ${USER_POOL_ID}"
echo "  ECS Cluster:      $(get_output "${STACK_PREFIX}-ecs-devenv" "ClusterName")"
echo ""
