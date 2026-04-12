import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_MCP_CONFIG_TABLE = process.env.DEPT_MCP_CONFIG_TABLE ?? "cc-dept-mcp-config";
const GATEWAY_MANAGER_FUNCTION = process.env.GATEWAY_MANAGER_FUNCTION ?? "cc-on-bedrock-gateway-manager";

const dynamodb = new DynamoDBClient({ region });
const lambdaClient = new LambdaClient({ region });
const DEPT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    // Get all GATEWAY records (COMMON + per-department)
    const result = await dynamodb.send(new ScanCommand({
      TableName: DEPT_MCP_CONFIG_TABLE,
      FilterExpression: "SK = :sk",
      ExpressionAttributeValues: marshall({ ":sk": "GATEWAY" }),
    }));

    const gateways = (result.Items ?? []).map((item) => {
      const u = unmarshall(item);
      const pk = u.PK ?? "";
      const isCommon = pk === "COMMON";
      return {
        deptId: isCommon ? "common" : pk.replace("DEPT#", ""),
        gatewayId: u.gatewayId ?? "",
        gatewayUrl: u.gatewayUrl ?? "",
        gatewayName: u.gatewayName ?? "",
        status: u.status ?? "UNKNOWN",
        targetCount: u.targetCount ?? 0,
        lastSyncAt: u.lastSyncAt ?? "",
        errorMessage: u.errorMessage ?? "",
      };
    });

    return NextResponse.json({ success: true, data: gateways });
  } catch (err) {
    console.error("[admin/mcp/gateways] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { dept_id } = body as { dept_id: string };

    if (!dept_id || !DEPT_PATTERN.test(dept_id)) {
      return NextResponse.json({ error: "Invalid dept_id (alphanumeric and hyphens only, 1-63 chars)" }, { status: 400 });
    }

    // Check if gateway already exists
    const existing = await dynamodb.send(new QueryCommand({
      TableName: DEPT_MCP_CONFIG_TABLE,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: marshall({ ":pk": `DEPT#${dept_id}`, ":sk": "GATEWAY" }),
    }));

    if (existing.Items?.length) {
      const u = unmarshall(existing.Items[0]);
      if (u.gatewayId) {
        return NextResponse.json({ error: "Gateway already exists", gatewayId: u.gatewayId }, { status: 409 });
      }
    }

    // Create GATEWAY record — triggers DDB Streams → gateway-manager Lambda
    const now = new Date().toISOString();
    await dynamodb.send(new PutItemCommand({
      TableName: DEPT_MCP_CONFIG_TABLE,
      Item: marshall({
        PK: `DEPT#${dept_id}`,
        SK: "GATEWAY",
        status: "CREATING",
        lastSyncAt: now,
      }, { removeUndefinedValues: true }),
    }));

    // Also invoke Lambda directly for immediate creation (DDB Streams has latency)
    await lambdaClient.send(new InvokeCommand({
      FunctionName: GATEWAY_MANAGER_FUNCTION,
      InvocationType: "Event",  // async
      Payload: Buffer.from(JSON.stringify({
        action: "create_gateway",
        dept_id,
      })),
    }));

    return NextResponse.json({ success: true, message: `Gateway creation initiated for ${dept_id}` });
  } catch (err) {
    console.error("[admin/mcp/gateways] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { dept_id } = body as { dept_id: string };

    if (!dept_id || !DEPT_PATTERN.test(dept_id)) {
      return NextResponse.json({ error: "Invalid dept_id (alphanumeric and hyphens only, 1-63 chars)" }, { status: 400 });
    }

    // Invoke gateway-manager Lambda for cleanup
    await lambdaClient.send(new InvokeCommand({
      FunctionName: GATEWAY_MANAGER_FUNCTION,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({
        action: "delete_gateway",
        dept_id,
      })),
    }));

    return NextResponse.json({ success: true, message: `Gateway deletion initiated for ${dept_id}` });
  } catch (err) {
    console.error("[admin/mcp/gateways] DELETE", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
