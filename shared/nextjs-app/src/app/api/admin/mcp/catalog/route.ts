import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const MCP_CATALOG_TABLE = process.env.MCP_CATALOG_TABLE ?? "cc-mcp-catalog";
const dynamodb = new DynamoDBClient({ region });

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: MCP_CATALOG_TABLE,
    }));

    const items = (result.Items ?? []).map((item) => {
      const u = unmarshall(item);
      return {
        id: u.catalogId ?? u.PK?.replace("CATALOG#", "") ?? "",
        name: u.name ?? "",
        description: u.description ?? "",
        category: u.category ?? "",
        tier: u.tier ?? "department",
        lambdaHandler: u.lambdaHandler ?? "",
        toolSchema: u.toolSchema ? JSON.parse(u.toolSchema) : [],
        version: u.version ?? "1.0.0",
        enabled: u.enabled ?? true,
        createdAt: u.createdAt ?? "",
      };
    });

    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error("[admin/mcp/catalog] GET", err instanceof Error ? err.message : err);
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
    const { id, name, description, category, tier, lambdaHandler, toolSchema, version } = body as {
      id: string; name: string; description: string; category: string;
      tier: string; lambdaHandler: string; toolSchema: unknown[]; version?: string;
    };

    if (!id || !name || !tier) {
      return NextResponse.json({ error: "id, name, and tier are required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    await dynamodb.send(new PutItemCommand({
      TableName: MCP_CATALOG_TABLE,
      Item: marshall({
        PK: `CATALOG#${id}`,
        SK: "META",
        catalogId: id,
        name,
        description: description ?? "",
        category: category ?? "",
        tier,
        lambdaHandler: lambdaHandler ?? "",
        toolSchema: JSON.stringify(toolSchema ?? []),
        version: version ?? "1.0.0",
        enabled: true,
        createdAt: now,
      }, { removeUndefinedValues: true }),
    }));

    return NextResponse.json({ success: true, message: "Catalog item created" });
  } catch (err) {
    console.error("[admin/mcp/catalog] POST", err instanceof Error ? err.message : err);
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
    const { id, name, description, category, enabled } = body as {
      id: string; name?: string; description?: string; category?: string; enabled?: boolean;
    };

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const updateParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": new Date().toISOString() };

    if (name !== undefined) { updateParts.push("#n = :name"); exprValues[":name"] = name; }
    if (description !== undefined) { updateParts.push("description = :desc"); exprValues[":desc"] = description; }
    if (category !== undefined) { updateParts.push("category = :cat"); exprValues[":cat"] = category; }
    if (enabled !== undefined) { updateParts.push("enabled = :en"); exprValues[":en"] = enabled; }

    const exprNames: Record<string, string> = {};
    if (name !== undefined) exprNames["#n"] = "name";

    await dynamodb.send(new UpdateItemCommand({
      TableName: MCP_CATALOG_TABLE,
      Key: marshall({ PK: `CATALOG#${id}`, SK: "META" }),
      UpdateExpression: `SET ${updateParts.join(", ")}`,
      ExpressionAttributeValues: marshall(exprValues, { removeUndefinedValues: true }),
      ...(Object.keys(exprNames).length > 0 ? { ExpressionAttributeNames: exprNames } : {}),
    }));

    return NextResponse.json({ success: true, message: "Catalog item updated" });
  } catch (err) {
    console.error("[admin/mcp/catalog] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
