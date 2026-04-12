"""
CC-on-Bedrock Gateway Manager Lambda
Manages per-department AgentCore Gateway lifecycle via DDB Streams events.

Triggers:
  - DDB Streams on cc-dept-mcp-config table
  - Direct invocation from Admin API (action: create_gateway, delete_gateway, sync)

DDB Event patterns:
  - INSERT DEPT#{dept}/GATEWAY -> create department gateway
  - INSERT DEPT#{dept}/MCP#{id} -> add target to department gateway
  - REMOVE DEPT#{dept}/MCP#{id} -> remove target from department gateway
  - REMOVE DEPT#{dept}/GATEWAY -> delete department gateway
"""
import boto3
import json
import os
import time
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ.get("REGION", "ap-northeast-2")
ACCOUNT_ID = os.environ.get("ACCOUNT_ID", "")
MCP_CATALOG_TABLE = os.environ.get("MCP_CATALOG_TABLE", "cc-mcp-catalog")
DEPT_MCP_CONFIG_TABLE = os.environ.get("DEPT_MCP_CONFIG_TABLE", "cc-dept-mcp-config")
DEPT_BUDGETS_TABLE = os.environ.get("DEPT_BUDGETS_TABLE", "cc-department-budgets")
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
PERMISSION_BOUNDARY_NAME = os.environ.get("PERMISSION_BOUNDARY_NAME", "cc-on-bedrock-task-boundary")

ddb = boto3.resource("dynamodb", region_name=REGION)
ddb_client = boto3.client("dynamodb", region_name=REGION)
agentcore = boto3.client("bedrock-agentcore-control", region_name=REGION)
iam_client = boto3.client("iam", region_name=REGION)
sns_client = boto3.client("sns", region_name=REGION)

config_table = ddb.Table(DEPT_MCP_CONFIG_TABLE)
catalog_table = ddb.Table(MCP_CATALOG_TABLE)
budgets_table = ddb.Table(DEPT_BUDGETS_TABLE)


def lambda_handler(event, context):
    """Main handler — routes DDB Streams events or direct invocations."""
    # Direct invocation from Admin API
    if "action" in event:
        return handle_direct_invocation(event)

    # DDB Streams event
    if "Records" in event:
        for record in event["Records"]:
            try:
                handle_stream_record(record)
            except Exception as e:
                logger.error(f"Error processing record: {e}", exc_info=True)
                raise  # Let DDB Streams retry
        return {"statusCode": 200, "processed": len(event["Records"])}

    return {"statusCode": 400, "error": "Unknown event type"}


def handle_direct_invocation(event):
    """Handle direct invocation from Admin API."""
    action = event["action"]
    dept_id = event.get("dept_id", "")

    if action == "create_gateway":
        return create_department_gateway(dept_id)
    elif action == "delete_gateway":
        return delete_department_gateway(dept_id)
    elif action == "sync":
        return sync_department_gateway(dept_id)
    else:
        return {"statusCode": 400, "error": f"Unknown action: {action}"}


def handle_stream_record(record):
    """Process a single DDB Streams record."""
    event_name = record["eventName"]  # INSERT, MODIFY, REMOVE
    new_image = record.get("dynamodb", {}).get("NewImage", {})
    old_image = record.get("dynamodb", {}).get("OldImage", {})

    # Extract PK/SK from the appropriate image
    image = new_image if new_image else old_image
    pk = image.get("PK", {}).get("S", "")
    sk = image.get("SK", {}).get("S", "")

    if not pk.startswith("DEPT#"):
        return  # Ignore COMMON records (managed separately)

    dept_id = pk.replace("DEPT#", "")

    if sk == "GATEWAY":
        if event_name == "INSERT":
            logger.info(f"Creating gateway for department: {dept_id}")
            create_department_gateway(dept_id)
        elif event_name == "MODIFY":
            status = new_image.get("status", {}).get("S", "")
            if status == "DELETING":
                logger.info(f"Deleting gateway for department (MODIFY→DELETING): {dept_id}")
                gateway_id = new_image.get("gatewayId", {}).get("S", "")
                if gateway_id:
                    cleanup_gateway(dept_id, gateway_id)
        elif event_name == "REMOVE":
            logger.info(f"Deleting gateway for department: {dept_id}")
            gateway_id = old_image.get("gatewayId", {}).get("S", "")
            if gateway_id:
                cleanup_gateway(dept_id, gateway_id)
    elif sk.startswith("MCP#"):
        catalog_id = sk.replace("MCP#", "")
        if event_name in ("INSERT", "MODIFY"):
            enabled = new_image.get("enabled", {}).get("BOOL", True)
            if enabled:
                logger.info(f"Adding MCP target {catalog_id} to {dept_id}")
                add_mcp_target(dept_id, catalog_id)
            else:
                logger.info(f"Removing MCP target {catalog_id} from {dept_id}")
                remove_mcp_target(dept_id, catalog_id)
        elif event_name == "REMOVE":
            logger.info(f"Removing MCP target {catalog_id} from {dept_id}")
            remove_mcp_target(dept_id, catalog_id)


# ============================================================================
# Gateway Lifecycle
# ============================================================================

def create_department_gateway(dept_id):
    """Create a new AgentCore Gateway for a department."""
    gateway_name = f"cconbedrock-{dept_id}-gateway"

    # Check if gateway already exists
    existing = find_gateway(gateway_name)
    if existing:
        logger.info(f"Gateway already exists: {gateway_name} ({existing})")
        update_gateway_record(dept_id, existing, gateway_name)
        return {"statusCode": 200, "gatewayId": existing, "status": "EXISTS"}

    # Ensure gateway IAM role exists
    gateway_role_arn = ensure_gateway_role(dept_id)
    gateway_id = None

    try:
        resp = agentcore.create_gateway(
            name=gateway_name,
            description=f"CC-on-Bedrock department gateway: {dept_id}",
            protocolType="MCP",
            authorizerType="NONE",
            roleArn=gateway_role_arn,
        )
        gateway_id = resp["gatewayId"]
        logger.info(f"Created gateway: {gateway_name} ({gateway_id})")

        # Wait for gateway to be ready
        time.sleep(5)

        # Update DDB record with gateway details
        gw_detail = agentcore.get_gateway(gatewayIdentifier=gateway_id)
        gateway_url = gw_detail.get("gatewayUrl", "")

        update_gateway_record(dept_id, gateway_id, gateway_name, gateway_url)

        return {"statusCode": 200, "gatewayId": gateway_id, "gatewayUrl": gateway_url}

    except Exception as e:
        logger.error(f"Failed to create gateway for {dept_id}: {e}")
        # Compensating transaction: rollback completed steps
        if gateway_id:
            try:
                agentcore.delete_gateway(gatewayIdentifier=gateway_id)
                logger.info(f"Rollback: deleted gateway {gateway_id}")
            except Exception as rollback_err:
                logger.error(f"Rollback gateway delete failed: {rollback_err}")
        if gateway_role_arn:
            try:
                cleanup_gateway_role(dept_id)
                logger.info(f"Rollback: deleted IAM role for {dept_id}")
            except Exception as rollback_err:
                logger.error(f"Rollback role delete failed: {rollback_err}")
        update_gateway_status(dept_id, "FAILED", str(e))
        notify_error(f"Gateway creation failed for dept {dept_id}: {e}")
        raise


def delete_department_gateway(dept_id):
    """Delete a department's AgentCore Gateway and all its targets."""
    record = config_table.get_item(Key={"PK": f"DEPT#{dept_id}", "SK": "GATEWAY"}).get("Item")
    if not record:
        return {"statusCode": 404, "error": f"No gateway found for {dept_id}"}

    gateway_id = record.get("gatewayId", "")
    if not gateway_id:
        return {"statusCode": 404, "error": f"No gatewayId for {dept_id}"}

    cleanup_gateway(dept_id, gateway_id)
    return {"statusCode": 200, "deleted": gateway_id}


def cleanup_gateway(dept_id, gateway_id):
    """Remove all targets and delete the gateway."""
    try:
        # Delete all targets first
        targets = agentcore.list_gateway_targets(gatewayIdentifier=gateway_id).get("items", [])
        for t in targets:
            try:
                agentcore.delete_gateway_target(
                    gatewayIdentifier=gateway_id,
                    targetId=t["targetId"],
                )
                logger.info(f"Deleted target: {t['name']}")
            except Exception as e:
                logger.warning(f"Failed to delete target {t['name']}: {e}")

        # Delete the gateway
        agentcore.delete_gateway(gatewayIdentifier=gateway_id)
        logger.info(f"Deleted gateway: {gateway_id}")

        # Clean up DDB records
        cleanup_dept_records(dept_id)

        # Clean up IAM role
        cleanup_gateway_role(dept_id)

    except Exception as e:
        logger.error(f"Error cleaning up gateway {gateway_id}: {e}")
        notify_error(f"Gateway cleanup failed for dept {dept_id}: {e}")


def sync_department_gateway(dept_id):
    """Re-sync a department gateway — reconcile DDB state with actual gateway targets."""
    record = config_table.get_item(Key={"PK": f"DEPT#{dept_id}", "SK": "GATEWAY"}).get("Item")
    if not record:
        return {"statusCode": 404, "error": f"No gateway found for {dept_id}"}

    gateway_id = record.get("gatewayId", "")

    # Get all MCP assignments from DDB
    resp = config_table.query(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues={":pk": f"DEPT#{dept_id}", ":prefix": "MCP#"},
    )
    assigned_mcps = {item["SK"].replace("MCP#", ""): item for item in resp.get("Items", []) if item.get("enabled", True)}

    # Get actual targets from gateway
    actual_targets = {t["name"]: t for t in agentcore.list_gateway_targets(gatewayIdentifier=gateway_id).get("items", [])}

    # Add missing targets
    for catalog_id in assigned_mcps:
        target_name = f"{catalog_id}-target"
        if target_name not in actual_targets:
            logger.info(f"Adding missing target: {target_name}")
            add_mcp_target(dept_id, catalog_id)

    # Remove extra targets
    for target_name, target in actual_targets.items():
        catalog_id = target_name.replace("-target", "")
        if catalog_id not in assigned_mcps:
            logger.info(f"Removing extra target: {target_name}")
            agentcore.delete_gateway_target(gatewayIdentifier=gateway_id, targetId=target["targetId"])

    # Synchronize
    agentcore.synchronize_gateway_targets(gatewayIdentifier=gateway_id)
    update_gateway_status(dept_id, "ACTIVE")

    return {"statusCode": 200, "synced": gateway_id}


# ============================================================================
# MCP Target Management
# ============================================================================

def add_mcp_target(dept_id, catalog_id):
    """Add an MCP catalog item as a target to a department's gateway."""
    # Get gateway ID
    gw_record = config_table.get_item(Key={"PK": f"DEPT#{dept_id}", "SK": "GATEWAY"}).get("Item")
    if not gw_record or not gw_record.get("gatewayId"):
        logger.error(f"No gateway found for {dept_id}, cannot add target")
        return

    gateway_id = gw_record["gatewayId"]

    # Get catalog item
    catalog_item = catalog_table.get_item(Key={"PK": f"CATALOG#{catalog_id}", "SK": "META"}).get("Item")
    if not catalog_item:
        logger.error(f"Catalog item not found: {catalog_id}")
        return

    tool_schema = json.loads(catalog_item.get("toolSchema", "[]"))
    lambda_handler = catalog_item.get("lambdaHandler", "")
    target_name = f"{catalog_id}-target"
    lambda_arn = f"arn:aws:lambda:{REGION}:{ACCOUNT_ID}:function:cc-on-bedrock-mcp-{catalog_id}"

    # Check if target already exists
    existing = agentcore.list_gateway_targets(gatewayIdentifier=gateway_id).get("items", [])
    for e in existing:
        if e["name"] == target_name:
            logger.info(f"Target already exists: {target_name}")
            config_table.update_item(
                Key={"PK": f"DEPT#{dept_id}", "SK": f"MCP#{catalog_id}"},
                UpdateExpression="SET targetId = :tid",
                ExpressionAttributeValues={":tid": e["targetId"]},
            )
            return

    try:
        resp = agentcore.create_gateway_target(
            gatewayIdentifier=gateway_id,
            name=target_name,
            description=f"{catalog_item.get('name', catalog_id)} for {dept_id}",
            targetConfiguration={
                "mcp": {
                    "lambda": {
                        "lambdaArn": lambda_arn,
                        "toolSchema": {"inlinePayload": tool_schema},
                    }
                }
            },
            credentialProviderConfigurations=[
                {"credentialProviderType": "GATEWAY_IAM_ROLE"}
            ],
        )
        target_id = resp.get("targetId", "")
        logger.info(f"Created target: {target_name} ({target_id})")

        # Update MCP record with targetId
        config_table.update_item(
            Key={"PK": f"DEPT#{dept_id}", "SK": f"MCP#{catalog_id}"},
            UpdateExpression="SET targetId = :tid",
            ExpressionAttributeValues={":tid": target_id},
        )

        # Synchronize gateway targets
        agentcore.synchronize_gateway_targets(gatewayIdentifier=gateway_id)

    except Exception as e:
        logger.error(f"Failed to add target {catalog_id} to {dept_id}: {e}")
        config_table.update_item(
            Key={"PK": f"DEPT#{dept_id}", "SK": f"MCP#{catalog_id}"},
            UpdateExpression="SET #s = :s, errorMessage = :e",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "FAILED", ":e": str(e)},
        )


def remove_mcp_target(dept_id, catalog_id):
    """Remove an MCP target from a department's gateway."""
    gw_record = config_table.get_item(Key={"PK": f"DEPT#{dept_id}", "SK": "GATEWAY"}).get("Item")
    if not gw_record or not gw_record.get("gatewayId"):
        return

    gateway_id = gw_record["gatewayId"]

    # Find target by name
    target_name = f"{catalog_id}-target"
    targets = agentcore.list_gateway_targets(gatewayIdentifier=gateway_id).get("items", [])
    for t in targets:
        if t["name"] == target_name:
            try:
                agentcore.delete_gateway_target(gatewayIdentifier=gateway_id, targetId=t["targetId"])
                agentcore.synchronize_gateway_targets(gatewayIdentifier=gateway_id)
                logger.info(f"Removed target: {target_name}")
            except Exception as e:
                logger.error(f"Failed to remove target {target_name}: {e}")
            return


# ============================================================================
# IAM Role Management
# ============================================================================

def ensure_gateway_role(dept_id):
    """Create or get the IAM role for a department's gateway."""
    role_name = f"cc-on-bedrock-agentcore-gateway-{dept_id}"
    role_arn = f"arn:aws:iam::{ACCOUNT_ID}:role/{role_name}"

    try:
        iam_client.get_role(RoleName=role_name)
        logger.info(f"Gateway role exists: {role_name}")
        return role_arn
    except iam_client.exceptions.NoSuchEntityException:
        pass

    # Create the role
    trust_policy = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    }

    boundary_arn = f"arn:aws:iam::{ACCOUNT_ID}:policy/{PERMISSION_BOUNDARY_NAME}"
    iam_client.create_role(
        RoleName=role_name,
        AssumeRolePolicyDocument=json.dumps(trust_policy),
        PermissionsBoundary=boundary_arn,
        Description=f"AgentCore Gateway role for department: {dept_id}",
        Tags=[
            {"Key": "project", "Value": "cc-on-bedrock"},
            {"Key": "department", "Value": dept_id},
            {"Key": "managed-by", "Value": "gateway-manager-lambda"},
        ],
    )

    # Attach Lambda invoke policy scoped to department MCP functions
    lambda_policy = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": "lambda:InvokeFunction",
            "Resource": f"arn:aws:lambda:{REGION}:{ACCOUNT_ID}:function:cc-on-bedrock-mcp-*",
        }],
    }
    iam_client.put_role_policy(
        RoleName=role_name,
        PolicyName="LambdaInvoke",
        PolicyDocument=json.dumps(lambda_policy),
    )

    logger.info(f"Created gateway role: {role_name}")
    # Wait for role propagation
    time.sleep(10)
    return role_arn


def cleanup_gateway_role(dept_id):
    """Delete the IAM role for a department's gateway."""
    role_name = f"cc-on-bedrock-agentcore-gateway-{dept_id}"
    try:
        # Remove inline policies
        policies = iam_client.list_role_policies(RoleName=role_name).get("PolicyNames", [])
        for p in policies:
            iam_client.delete_role_policy(RoleName=role_name, PolicyName=p)
        # Remove attached policies
        attached = iam_client.list_attached_role_policies(RoleName=role_name).get("AttachedPolicies", [])
        for p in attached:
            iam_client.detach_role_policy(RoleName=role_name, PolicyArn=p["PolicyArn"])
        # Delete role
        iam_client.delete_role(RoleName=role_name)
        logger.info(f"Deleted gateway role: {role_name}")
    except iam_client.exceptions.NoSuchEntityException:
        pass
    except Exception as e:
        logger.warning(f"Failed to cleanup role {role_name}: {e}")


# ============================================================================
# DynamoDB Helpers
# ============================================================================

def find_gateway(gateway_name):
    """Find an existing gateway by name, return gatewayId or None."""
    gateways = agentcore.list_gateways().get("items", [])
    for g in gateways:
        if g.get("name", "") == gateway_name:
            return g["gatewayId"]
    return None


def update_gateway_record(dept_id, gateway_id, gateway_name, gateway_url=None):
    """Update the GATEWAY record in cc-dept-mcp-config and cc-department-budgets."""
    update_expr = "SET gatewayId = :gid, gatewayName = :gn, #s = :s, lastSyncAt = :ts"
    expr_values = {
        ":gid": gateway_id,
        ":gn": gateway_name,
        ":s": "ACTIVE",
        ":ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    if gateway_url:
        update_expr += ", gatewayUrl = :url"
        expr_values[":url"] = gateway_url

    config_table.update_item(
        Key={"PK": f"DEPT#{dept_id}", "SK": "GATEWAY"},
        UpdateExpression=update_expr,
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues=expr_values,
    )

    # Also copy gatewayUrl to department budgets table for fast EC2 boot resolution
    if gateway_url:
        try:
            budgets_table.update_item(
                Key={"dept_id": dept_id},
                UpdateExpression="SET gatewayUrl = :url",
                ExpressionAttributeValues={":url": gateway_url},
            )
        except Exception as e:
            logger.warning(f"Failed to update budgets table for {dept_id}: {e}")


def update_gateway_status(dept_id, status, error_message=None):
    """Update gateway status in DDB."""
    update_expr = "SET #s = :s, lastSyncAt = :ts"
    expr_values = {":s": status, ":ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    expr_names = {"#s": "status"}

    if error_message:
        update_expr += ", errorMessage = :e"
        expr_values[":e"] = error_message

    config_table.update_item(
        Key={"PK": f"DEPT#{dept_id}", "SK": "GATEWAY"},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )


def cleanup_dept_records(dept_id):
    """Remove all DDB records for a department."""
    resp = config_table.query(
        KeyConditionExpression="PK = :pk",
        ExpressionAttributeValues={":pk": f"DEPT#{dept_id}"},
    )
    for item in resp.get("Items", []):
        config_table.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

    # Remove gatewayUrl from budgets table
    try:
        budgets_table.update_item(
            Key={"dept_id": dept_id},
            UpdateExpression="REMOVE gatewayUrl",
        )
    except Exception:
        pass


def notify_error(message):
    """Send error notification via SNS."""
    if not SNS_TOPIC_ARN:
        return
    try:
        sns_client.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject="[CC-on-Bedrock] Gateway Manager Error",
            Message=message,
        )
    except Exception as e:
        logger.warning(f"Failed to send SNS notification: {e}")
