import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_MCP_CONFIG_TABLE = process.env.DEPT_MCP_CONFIG_TABLE ?? "cc-dept-mcp-config";
const dynamodb = new DynamoDBClient({ region });

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const deptId = searchParams.get("dept_id");

  if (!deptId) {
    return NextResponse.json({ error: "dept_id is required" }, { status: 400 });
  }

  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: DEPT_MCP_CONFIG_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: marshall({
        ":pk": `DEPT#${deptId}`,
        ":prefix": "MCP#",
      }),
    }));

    const assignments = (result.Items ?? []).map((item) => {
      const u = unmarshall(item);
      return {
        catalogId: u.SK?.replace("MCP#", "") ?? "",
        enabled: u.enabled ?? true,
        targetId: u.targetId ?? "",
        status: u.status ?? "ACTIVE",
        addedAt: u.addedAt ?? "",
        addedBy: u.addedBy ?? "",
      };
    });

    return NextResponse.json({ success: true, data: assignments });
  } catch (err) {
    console.error("[admin/mcp/assignments] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { dept_id, catalog_id, action } = body as {
      dept_id: string; catalog_id: string; action: "assign" | "remove";
    };

    if (!dept_id || !catalog_id || !action) {
      return NextResponse.json({ error: "dept_id, catalog_id, and action are required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const adminEmail = session.user.email ?? "unknown";

    if (action === "assign") {
      // Check gateway exists for the department
      const gwResult = await dynamodb.send(new QueryCommand({
        TableName: DEPT_MCP_CONFIG_TABLE,
        KeyConditionExpression: "PK = :pk AND SK = :sk",
        ExpressionAttributeValues: marshall({ ":pk": `DEPT#${dept_id}`, ":sk": "GATEWAY" }),
      }));
      if (!gwResult.Items?.length) {
        return NextResponse.json({ error: "Department gateway not found. Create gateway first." }, { status: 400 });
      }

      // Add MCP assignment — DDB Streams will trigger gateway-manager Lambda
      await dynamodb.send(new PutItemCommand({
        TableName: DEPT_MCP_CONFIG_TABLE,
        Item: marshall({
          PK: `DEPT#${dept_id}`,
          SK: `MCP#${catalog_id}`,
          enabled: true,
          addedAt: now,
          addedBy: adminEmail,
          status: "PENDING",
        }, { removeUndefinedValues: true }),
      }));

      return NextResponse.json({ success: true, message: `MCP ${catalog_id} assigned to ${dept_id}` });
    } else if (action === "remove") {
      // Remove MCP assignment — DDB Streams will trigger target removal
      await dynamodb.send(new DeleteItemCommand({
        TableName: DEPT_MCP_CONFIG_TABLE,
        Key: marshall({ PK: `DEPT#${dept_id}`, SK: `MCP#${catalog_id}` }),
      }));

      return NextResponse.json({ success: true, message: `MCP ${catalog_id} removed from ${dept_id}` });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("[admin/mcp/assignments] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
