#!/bin/bash
set -euo pipefail

# CC-on-Bedrock: Cognito Authentication Setup
# Configures Cognito SSM parameters, creates the first admin user,
# and optionally sets up SAML/OIDC federation (Okta, Azure AD, etc.).
#
# This script supports three modes:
#   1. Native Cognito (email + password) - default
#   2. SAML Federation (Okta, Azure AD, OneLogin, etc.)
#   3. OIDC Federation (Google, GitHub, any OIDC provider)
#
# Usage: ./04-setup-cognito-auth.sh [--admin-email admin@example.com]
#        ./04-setup-cognito-auth.sh --saml --metadata-url https://okta.example.com/metadata.xml
#        ./04-setup-cognito-auth.sh --oidc --issuer https://accounts.google.com --client-id XXX --client-secret YYY

REGION="${AWS_REGION:-ap-northeast-2}"
PROJECT_PREFIX="cc-on-bedrock"

# Defaults
AUTH_MODE="native"
ADMIN_EMAIL=""
SAML_METADATA_URL=""
SAML_METADATA_FILE=""
OIDC_ISSUER=""
OIDC_CLIENT_ID=""
OIDC_CLIENT_SECRET=""
PROVIDER_NAME=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --saml) AUTH_MODE="saml"; shift ;;
    --oidc) AUTH_MODE="oidc"; shift ;;
    --metadata-url) SAML_METADATA_URL="$2"; shift 2 ;;
    --metadata-file) SAML_METADATA_FILE="$2"; shift 2 ;;
    --issuer) OIDC_ISSUER="$2"; shift 2 ;;
    --client-id) OIDC_CLIENT_ID="$2"; shift 2 ;;
    --client-secret) OIDC_CLIENT_SECRET="$2"; shift 2 ;;
    --provider-name) PROVIDER_NAME="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --admin-email EMAIL     Admin user email (prompted if not set)"
      echo "  --saml                  Enable SAML federation"
      echo "  --oidc                  Enable OIDC federation"
      echo "  --metadata-url URL      SAML metadata URL (e.g., Okta app metadata)"
      echo "  --metadata-file FILE    SAML metadata XML file path"
      echo "  --issuer URL            OIDC issuer URL"
      echo "  --client-id ID          OIDC client ID"
      echo "  --client-secret SECRET  OIDC client secret"
      echo "  --provider-name NAME    IdP provider name (default: auto-generated)"
      echo ""
      echo "Examples:"
      echo "  $0 --admin-email admin@corp.com"
      echo "  $0 --saml --metadata-url https://mycompany.okta.com/app/xxx/sso/saml/metadata"
      echo "  $0 --oidc --issuer https://accounts.google.com --client-id xxx --client-secret yyy"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== Cognito Authentication Setup ==="
echo "Region: $REGION"
echo "Auth mode: $AUTH_MODE"
echo ""

# Find Cognito User Pool
USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 20 --region "$REGION" \
  --query "UserPools[?contains(Name, '${PROJECT_PREFIX}')].Id | [0]" --output text)

if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  echo "ERROR: Cognito User Pool not found. Deploy CcOnBedrock-Security stack first (./03-deploy-base-stacks.sh)"
  exit 1
fi
echo "User Pool: $USER_POOL_ID"

# Find App Client
CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$USER_POOL_ID" --region "$REGION" \
  --query "UserPoolClients[?contains(ClientName, 'dashboard')].ClientId | [0]" --output text)

if [ -z "$CLIENT_ID" ] || [ "$CLIENT_ID" = "None" ]; then
  # Try any client
  CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$USER_POOL_ID" --region "$REGION" \
    --query "UserPoolClients[0].ClientId" --output text)
fi
echo "App Client: $CLIENT_ID"

# Get Client Secret
CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" \
  --query "UserPoolClient.ClientSecret" --output text 2>/dev/null || echo "")

# --- Store SSM Parameters ---
echo ""
echo "Storing SSM parameters..."

aws ssm put-parameter \
  --name "/${PROJECT_PREFIX}/cognito/user-pool-id" \
  --value "$USER_POOL_ID" \
  --type String --overwrite --region "$REGION" &>/dev/null
echo "  /${PROJECT_PREFIX}/cognito/user-pool-id = $USER_POOL_ID"

aws ssm put-parameter \
  --name "/${PROJECT_PREFIX}/cognito/client-id" \
  --value "$CLIENT_ID" \
  --type String --overwrite --region "$REGION" &>/dev/null
echo "  /${PROJECT_PREFIX}/cognito/client-id = $CLIENT_ID"

if [ -n "$CLIENT_SECRET" ] && [ "$CLIENT_SECRET" != "None" ]; then
  aws ssm put-parameter \
    --name "/${PROJECT_PREFIX}/cognito/client-secret" \
    --value "$CLIENT_SECRET" \
    --type SecureString --overwrite --region "$REGION" &>/dev/null
  echo "  /${PROJECT_PREFIX}/cognito/client-secret = (stored as SecureString)"
fi

# --- Create Admin User ---
echo ""
if [ -z "$ADMIN_EMAIL" ]; then
  read -rp "Enter admin email (or press Enter to skip): " ADMIN_EMAIL
fi

if [ -n "$ADMIN_EMAIL" ]; then
  echo "Creating admin user: $ADMIN_EMAIL"

  # Check if user exists
  if aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$ADMIN_EMAIL" --region "$REGION" &>/dev/null; then
    echo "  User already exists, adding to admin group..."
  else
    TEMP_PASS=$(openssl rand -base64 12)
    aws cognito-idp admin-create-user \
      --user-pool-id "$USER_POOL_ID" \
      --username "$ADMIN_EMAIL" \
      --user-attributes \
        Name=email,Value="$ADMIN_EMAIL" \
        Name=email_verified,Value=true \
        Name="custom:subdomain",Value="admin" \
        Name="custom:department",Value="platform" \
        Name="custom:security_policy",Value="open" \
        Name="custom:container_os",Value="ubuntu" \
        Name="custom:resource_tier",Value="power" \
      --temporary-password "$TEMP_PASS" \
      --region "$REGION" &>/dev/null
    echo "  User created. Temporary password: $TEMP_PASS"
    echo "  (User must change password on first login)"
  fi

  # Ensure admin group exists
  aws cognito-idp create-group \
    --user-pool-id "$USER_POOL_ID" \
    --group-name admin \
    --description "Platform administrators" \
    --region "$REGION" 2>/dev/null || true

  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --group-name admin \
    --region "$REGION"
  echo "  Added to 'admin' group"

  # Also create dept-manager group
  aws cognito-idp create-group \
    --user-pool-id "$USER_POOL_ID" \
    --group-name dept-manager \
    --description "Department managers" \
    --region "$REGION" 2>/dev/null || true
  echo "  'dept-manager' group ready"
fi

# --- SAML Federation ---
if [ "$AUTH_MODE" = "saml" ]; then
  echo ""
  echo "--- Setting up SAML Federation ---"
  PROVIDER_NAME="${PROVIDER_NAME:-CorporateSAML}"

  SAML_ARGS="--user-pool-id $USER_POOL_ID --provider-name $PROVIDER_NAME --provider-type SAML"
  SAML_ARGS="$SAML_ARGS --attribute-mapping email=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"

  if [ -n "$SAML_METADATA_URL" ]; then
    SAML_ARGS="$SAML_ARGS --provider-details MetadataURL=$SAML_METADATA_URL"
  elif [ -n "$SAML_METADATA_FILE" ]; then
    SAML_ARGS="$SAML_ARGS --provider-details MetadataFile=$(cat "$SAML_METADATA_FILE")"
  else
    echo "ERROR: --metadata-url or --metadata-file required for SAML"
    exit 1
  fi

  # Create or update IdP
  if aws cognito-idp describe-identity-provider \
    --user-pool-id "$USER_POOL_ID" --provider-name "$PROVIDER_NAME" --region "$REGION" &>/dev/null; then
    echo "  Updating existing SAML provider: $PROVIDER_NAME"
    aws cognito-idp update-identity-provider \
      --user-pool-id "$USER_POOL_ID" \
      --provider-name "$PROVIDER_NAME" \
      --provider-details MetadataURL="$SAML_METADATA_URL" \
      --region "$REGION" &>/dev/null
  else
    echo "  Creating SAML provider: $PROVIDER_NAME"
    eval aws cognito-idp create-identity-provider $SAML_ARGS --region "$REGION" &>/dev/null
  fi

  # Enable IdP on app client
  echo "  Enabling SAML provider on app client..."
  aws cognito-idp update-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-id "$CLIENT_ID" \
    --supported-identity-providers COGNITO "$PROVIDER_NAME" \
    --region "$REGION" &>/dev/null
  echo "  SAML federation configured"

  # Print Cognito SAML endpoints for IdP configuration
  COGNITO_DOMAIN=$(aws cognito-idp describe-user-pool --user-pool-id "$USER_POOL_ID" --region "$REGION" \
    --query "UserPool.Domain" --output text 2>/dev/null || echo "")
  if [ -n "$COGNITO_DOMAIN" ] && [ "$COGNITO_DOMAIN" != "None" ]; then
    echo ""
    echo "  Configure your IdP with these endpoints:"
    echo "    ACS URL:      https://${COGNITO_DOMAIN}.auth.${REGION}.amazoncognito.com/saml2/idpresponse"
    echo "    Entity ID:    urn:amazon:cognito:sp:${USER_POOL_ID}"
    echo "    Sign-in URL:  https://${COGNITO_DOMAIN}.auth.${REGION}.amazoncognito.com/login"
  fi
fi

# --- OIDC Federation ---
if [ "$AUTH_MODE" = "oidc" ]; then
  echo ""
  echo "--- Setting up OIDC Federation ---"
  PROVIDER_NAME="${PROVIDER_NAME:-CorporateOIDC}"

  if [ -z "$OIDC_ISSUER" ] || [ -z "$OIDC_CLIENT_ID" ] || [ -z "$OIDC_CLIENT_SECRET" ]; then
    echo "ERROR: --issuer, --client-id, and --client-secret required for OIDC"
    exit 1
  fi

  if aws cognito-idp describe-identity-provider \
    --user-pool-id "$USER_POOL_ID" --provider-name "$PROVIDER_NAME" --region "$REGION" &>/dev/null; then
    echo "  Updating existing OIDC provider: $PROVIDER_NAME"
    aws cognito-idp update-identity-provider \
      --user-pool-id "$USER_POOL_ID" \
      --provider-name "$PROVIDER_NAME" \
      --provider-details \
        oidc_issuer="$OIDC_ISSUER" \
        client_id="$OIDC_CLIENT_ID" \
        client_secret="$OIDC_CLIENT_SECRET" \
        attributes_request_method=GET \
        authorize_scopes="openid email profile" \
      --region "$REGION" &>/dev/null
  else
    echo "  Creating OIDC provider: $PROVIDER_NAME"
    aws cognito-idp create-identity-provider \
      --user-pool-id "$USER_POOL_ID" \
      --provider-name "$PROVIDER_NAME" \
      --provider-type OIDC \
      --provider-details \
        oidc_issuer="$OIDC_ISSUER" \
        client_id="$OIDC_CLIENT_ID" \
        client_secret="$OIDC_CLIENT_SECRET" \
        attributes_request_method=GET \
        authorize_scopes="openid email profile" \
      --attribute-mapping email=email \
      --region "$REGION" &>/dev/null
  fi

  # Enable IdP on app client
  echo "  Enabling OIDC provider on app client..."
  aws cognito-idp update-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-id "$CLIENT_ID" \
    --supported-identity-providers COGNITO "$PROVIDER_NAME" \
    --region "$REGION" &>/dev/null
  echo "  OIDC federation configured"
fi

echo ""
echo "=== Cognito Setup Complete ==="
echo "Auth mode: $AUTH_MODE"
echo "User Pool: $USER_POOL_ID"
echo "Client ID: $CLIENT_ID"
echo "SSM params stored under: /${PROJECT_PREFIX}/cognito/"
echo ""
echo "Next: ./05-build-docker-images.sh"
