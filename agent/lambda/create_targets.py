"""
Create CC-on-Bedrock Gateway + Lambda Targets
Usage: ACCOUNT_ID=<your-account-id> python3 agent/lambda/create_targets.py

1. Creates 3 Lambda functions (cc-ecs-mcp, cc-cloudwatch-mcp, cc-dynamodb-mcp)
2. Creates Gateway (cconbedrock-gateway)
3. Registers Lambda targets on Gateway
"""
import boto3
import json
import os
import sys
import zipfile
import io
import time

REGION = os.environ.get("REGION", "ap-northeast-2")
ACCOUNT_ID = os.environ.get("ACCOUNT_ID", "")
if not ACCOUNT_ID:
    import boto3
    ACCOUNT_ID = boto3.client("sts").get_caller_identity()["Account"]
LAMBDA_ROLE = os.environ.get("LAMBDA_ROLE", f"arn:aws:iam::{ACCOUNT_ID}:role/cc-on-bedrock-agentcore-lambda")
GATEWAY_ROLE = os.environ.get("GATEWAY_ROLE", f"arn:aws:iam::{ACCOUNT_ID}:role/cc-on-bedrock-agentcore-gateway")
PREFIX = "cconbedrock"

lambda_client = boto3.client("lambda", region_name=REGION)
agentcore = boto3.client("bedrock-agentcore-control", region_name=REGION)


def prop(t, d=""):
    r = {"type": t}
    if d:
        r["description"] = d
    return r


# ============================================================================
# Step 1: Create Lambda Functions
# ============================================================================
LAMBDAS = {
    f"{PREFIX}-ecs-mcp": {
        "file": "cc_ecs_mcp.py",
        "handler": "cc_ecs_mcp.lambda_handler",
        "desc": "CC-on-Bedrock ECS MCP - container status, EFS info",
    },
    f"{PREFIX}-cloudwatch-mcp": {
        "file": "cc_cloudwatch_mcp.py",
        "handler": "cc_cloudwatch_mcp.lambda_handler",
        "desc": "CC-on-Bedrock CloudWatch MCP - Container Insights metrics",
    },
    f"{PREFIX}-dynamodb-mcp": {
        "file": "cc_dynamodb_mcp.py",
        "handler": "cc_dynamodb_mcp.lambda_handler",
        "desc": "CC-on-Bedrock DynamoDB MCP - usage, budget, health",
    },
}


def create_zip(filepath):
    """Create ZIP from a single Python file."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(filepath, os.path.basename(filepath))
    return buf.getvalue()


def deploy_lambda(name, config):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    filepath = os.path.join(script_dir, config["file"])

    if not os.path.exists(filepath):
        print(f"  SKIP {name}: {filepath} not found")
        return False

    zip_bytes = create_zip(filepath)

    try:
        lambda_client.get_function(FunctionName=name)
        # Update existing
        lambda_client.update_function_code(FunctionName=name, ZipFile=zip_bytes)
        print(f"  UPDATED: {name}")
    except lambda_client.exceptions.ResourceNotFoundException:
        # Create new
        lambda_client.create_function(
            FunctionName=name,
            Runtime="python3.12",
            Role=LAMBDA_ROLE,
            Handler=config["handler"],
            Code={"ZipFile": zip_bytes},
            Description=config["desc"],
            Timeout=30,
            MemorySize=256,
            Architectures=["arm64"],
        )
        print(f"  CREATED: {name}")

    return True


print("=== Step 1: Deploy Lambda Functions ===")
for name, config in LAMBDAS.items():
    deploy_lambda(name, config)

# ============================================================================
# Step 2: Create Gateway
# ============================================================================
print("\n=== Step 2: Create/Find Gateway ===")
GATEWAY_NAME = f"{PREFIX}-gateway"

gateways = agentcore.list_gateways().get("items", [])
gateway_id = None
for g in gateways:
    if g.get("name", "") == GATEWAY_NAME:
        gateway_id = g["gatewayId"]
        print(f"  EXISTS: {GATEWAY_NAME} ({gateway_id})")
        break

if not gateway_id:
    try:
        resp = agentcore.create_gateway(
            name=GATEWAY_NAME,
            description="CC-on-Bedrock AI Assistant Gateway - ECS, CloudWatch, DynamoDB tools",
            protocolType="MCP",
            authorizerType="NONE",
            roleArn=GATEWAY_ROLE,
        )
        gateway_id = resp["gatewayId"]
        print(f"  CREATED: {GATEWAY_NAME} ({gateway_id})")
        print("  Waiting for gateway to become READY...")
        time.sleep(10)
    except Exception as e:
        print(f"  ERROR creating gateway: {e}")
        sys.exit(1)

# Get gateway URL
try:
    gw_detail = agentcore.get_gateway(gatewayIdentifier=gateway_id)
    gw_status = gw_detail.get("status", "UNKNOWN")
    print(f"  Status: {gw_status}")
except Exception as e:
    print(f"  Warning: Could not get gateway details: {e}")

# ============================================================================
# Step 3: Register Lambda Targets
# ============================================================================
print("\n=== Step 3: Register Lambda Targets ===")


def create_target(gw_id, name, fn, desc, tools):
    arn = f"arn:aws:lambda:{REGION}:{ACCOUNT_ID}:function:{fn}"
    existing = agentcore.list_gateway_targets(gatewayIdentifier=gw_id).get("items", [])
    for e in existing:
        if e["name"] == name:
            print(f"  EXISTS: {name}")
            return
    try:
        resp = agentcore.create_gateway_target(
            gatewayIdentifier=gw_id,
            name=name,
            description=desc,
            targetConfiguration={
                "mcp": {
                    "lambda": {
                        "lambdaArn": arn,
                        "toolSchema": {"inlinePayload": tools},
                    }
                }
            },
            credentialProviderConfigurations=[
                {"credentialProviderType": "GATEWAY_IAM_ROLE"}
            ],
        )
        print(f"  CREATED: {name} -> {resp.get('targetId', '')}")
    except Exception as e:
        print(f"  ERR: {name} -> {str(e)[:150]}")


# ECS MCP Target
create_target(
    gateway_id, "ecs-mcp-target", f"{PREFIX}-ecs-mcp",
    "ECS container status and EFS info (2 tools)",
    [
        {"name": n, "description": d, "inputSchema": s}
        for n, d, s in [
            ("get_container_status", "Get all ECS container status with user assignments, OS/tier distribution",
             {"type": "object", "properties": {"cluster": prop("string", "ECS cluster name (default: cc-on-bedrock-devenv)")}}),
            ("get_efs_info", "Get EFS file system info: size, mount targets, encryption",
             {"type": "object", "properties": {"fileSystemId": prop("string", "EFS file system ID")}}),
        ]
    ],
)

# CloudWatch MCP Target
create_target(
    gateway_id, "cloudwatch-mcp-target", f"{PREFIX}-cloudwatch-mcp",
    "CloudWatch Container Insights metrics (1 tool)",
    [
        {"name": "get_container_metrics", "description": "Get ECS cluster CPU, Memory, Network metrics from Container Insights",
         "inputSchema": {"type": "object", "properties": {
             "cluster": prop("string", "ECS cluster name"),
             "minutes": prop("integer", "Lookback period in minutes (default: 10)"),
         }}},
    ],
)

# DynamoDB MCP Target
create_target(
    gateway_id, "dynamodb-mcp-target", f"{PREFIX}-dynamodb-mcp",
    "Usage tracking, budget status, system health (5 tools)",
    [
        {"name": n, "description": d, "inputSchema": s}
        for n, d, s in [
            ("get_spend_summary", "Get total spend, tokens, per-user breakdown for N days",
             {"type": "object", "properties": {"days": prop("integer", "Number of days (default: 7)")}}),
            ("get_budget_status", "Get today's budget utilization per user",
             {"type": "object", "properties": {"daily_budget": prop("number", "Daily budget in USD (default: 50)")}}),
            ("get_system_health", "Get platform health: DynamoDB, ECS status",
             {"type": "object", "properties": {}}),
            ("get_user_usage", "Get specific user's daily usage and model breakdown",
             {"type": "object", "properties": {"user_id": prop("string", "User ID (subdomain)"), "days": prop("integer", "Days")}, "required": ["user_id"]}),
            ("get_department_usage", "Get department-level usage comparison",
             {"type": "object", "properties": {"days": prop("integer", "Number of days (default: 7)")}}),
        ]
    ],
)

# Sync targets
print("\n=== Step 4: Sync Gateway Targets ===")
try:
    agentcore.synchronize_gateway_targets(gatewayIdentifier=gateway_id)
    print("  Sync initiated")
except Exception as e:
    print(f"  Sync error: {e}")

print(f"\n=== DONE ===")
print(f"Gateway ID: {gateway_id}")
print(f"Gateway Name: {GATEWAY_NAME}")
print(f"Lambda Functions: {list(LAMBDAS.keys())}")
