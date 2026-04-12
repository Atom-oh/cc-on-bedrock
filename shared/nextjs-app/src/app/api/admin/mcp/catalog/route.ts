import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const MCP_CATALOG_TABLE = process.env.MCP_CATALOG_TABLE ?? "cc-mcp-catalog";

const dynamodb = new DynamoDBClient({ region });

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const result = await dynamodb.send(
      new ScanCommand({ TableName: MCP_CATALOG_TABLE })
    );

    const items = (result.Items ?? []).map((item) => {
      const u = unmarshall(item);
      return {
        mcpId: u.PK?.replace("MCP#", "") ?? "",
        name: u.name ?? "",
        description: u.description ?? "",
        category: u.category ?? "common",
        lambdaArn: u.lambdaArn ?? "",
        tools: u.tools ?? [],
        enabled: u.enabled !== false,
        createdAt: u.createdAt ?? "",
      };
    });

    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error("[mcp/catalog] GET", err instanceof Error ? err.message : err);
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
    const { mcpId, name, description, category, lambdaArn, tools } = body;

    if (!mcpId || !name) {
      return NextResponse.json({ error: "mcpId and name required" }, { status: 400 });
    }

    await dynamodb.send(
      new PutItemCommand({
        TableName: MCP_CATALOG_TABLE,
        Item: marshall({
          PK: `MCP#${mcpId}`,
          SK: "META",
          name,
          description: description ?? "",
          category: category ?? "department",
          lambdaArn: lambdaArn ?? "",
          tools: tools ?? [],
          enabled: true,
          createdAt: new Date().toISOString(),
        }),
      })
    );

    return NextResponse.json({ success: true, data: { mcpId } });
  } catch (err) {
    console.error("[mcp/catalog] POST", err instanceof Error ? err.message : err);
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
    const { mcpId, ...updates } = body;

    if (!mcpId) {
      return NextResponse.json({ error: "mcpId required" }, { status: 400 });
    }

    const ALLOWED_FIELDS = ["name", "description", "category", "lambdaArn", "tools", "enabled"];
    const filtered = Object.fromEntries(
      Object.entries(updates).filter(([k]) => ALLOWED_FIELDS.includes(k))
    );

    const expressionParts: string[] = [];
    const attrNames: Record<string, string> = {};
    const attrValues: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(filtered)) {
      const placeholder = `#${key}`;
      const valKey = `:${key}`;
      expressionParts.push(`${placeholder} = ${valKey}`);
      attrNames[placeholder] = key;
      attrValues[valKey] = value;
    }

    attrValues[":updatedAt"] = new Date().toISOString();
    expressionParts.push("updatedAt = :updatedAt");

    await dynamodb.send(
      new UpdateItemCommand({
        TableName: MCP_CATALOG_TABLE,
        Key: marshall({ PK: `MCP#${mcpId}`, SK: "META" }),
        UpdateExpression: `SET ${expressionParts.join(", ")}`,
        ExpressionAttributeNames: Object.keys(attrNames).length > 0 ? attrNames : undefined,
        ExpressionAttributeValues: marshall(attrValues),
      })
    );

    return NextResponse.json({ success: true, data: { mcpId } });
  } catch (err) {
    console.error("[mcp/catalog] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
