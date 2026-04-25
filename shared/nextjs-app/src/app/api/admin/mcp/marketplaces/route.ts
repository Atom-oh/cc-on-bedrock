import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_MCP_CONFIG_TABLE =
  process.env.DEPT_MCP_CONFIG_TABLE ?? "cc-dept-mcp-config";
const dynamodb = new DynamoDBClient({ region });

const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const SCOPE_PATTERN = /^[a-z0-9-]{1,64}$/;
const GITHUB_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/?$/;

function scopeToPK(scope: string): string {
  return scope === "common" ? "COMMON" : `DEPT#${scope}`;
}

function validateIdAndScope(
  id: unknown,
  scope: unknown
): { id: string; scope: string } | { error: string } {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return { error: "id must be lowercase alphanumeric with hyphens (max 64)" };
  }
  if (typeof scope !== "string" || (scope !== "common" && !SCOPE_PATTERN.test(scope))) {
    return { error: "scope must be 'common' or a valid department slug" };
  }
  return { id, scope };
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get("scope") ?? "common";

  try {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: DEPT_MCP_CONFIG_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: marshall({
          ":pk": scopeToPK(scope),
          ":prefix": "MKTPLACE#",
        }),
      })
    );

    const marketplaces = (result.Items ?? []).map((item) => {
      const u = unmarshall(item);
      return {
        id: (u.SK as string).replace("MKTPLACE#", ""),
        name: u.name ?? "",
        url: u.url ?? "",
        description: u.description ?? "",
        enabled: u.enabled ?? true,
        addedBy: u.addedBy ?? "",
        addedAt: u.addedAt ?? "",
      };
    });

    return NextResponse.json({ success: true, data: marketplaces });
  } catch (err) {
    console.error(
      "[admin/mcp/marketplaces] GET",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { id, name, url, description, scope } = body as {
      id: string;
      name: string;
      url: string;
      description?: string;
      scope: string;
    };

    if (!id || !name || !url || !scope) {
      return NextResponse.json(
        { error: "id, name, url, and scope are required" },
        { status: 400 }
      );
    }

    const validated = validateIdAndScope(id, scope);
    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    if (typeof name !== "string" || name.length === 0 || name.length > 128) {
      return NextResponse.json(
        { error: "name must be 1-128 characters" },
        { status: 400 }
      );
    }

    if (!GITHUB_URL_PATTERN.test(url)) {
      return NextResponse.json(
        { error: "URL must match https://github.com/<owner>/<repo>" },
        { status: 400 }
      );
    }

    if (description !== undefined && (typeof description !== "string" || description.length > 512)) {
      return NextResponse.json(
        { error: "description must be at most 512 characters" },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const adminEmail = session.user.email ?? "unknown";

    try {
      await dynamodb.send(
        new PutItemCommand({
          TableName: DEPT_MCP_CONFIG_TABLE,
          Item: marshall(
            {
              PK: scopeToPK(validated.scope),
              SK: `MKTPLACE#${validated.id}`,
              name,
              url,
              description: description ?? "",
              enabled: true,
              addedBy: adminEmail,
              addedAt: now,
            },
            { removeUndefinedValues: true }
          ),
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        })
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return NextResponse.json(
          { error: `Marketplace '${validated.id}' already exists in scope '${validated.scope}'` },
          { status: 409 }
        );
      }
      throw err;
    }

    return NextResponse.json({
      success: true,
      message: `Marketplace ${validated.id} added to ${validated.scope}`,
    });
  } catch (err) {
    console.error(
      "[admin/mcp/marketplaces] POST",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { id, scope, enabled, name, url, description } = body as {
      id: string;
      scope: string;
      enabled?: boolean;
      name?: string;
      url?: string;
      description?: string;
    };

    if (!id || !scope) {
      return NextResponse.json(
        { error: "id and scope are required" },
        { status: 400 }
      );
    }

    const validated = validateIdAndScope(id, scope);
    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    if (url !== undefined && !GITHUB_URL_PATTERN.test(url)) {
      return NextResponse.json(
        { error: "URL must match https://github.com/<owner>/<repo>" },
        { status: 400 }
      );
    }

    if (name !== undefined && (typeof name !== "string" || name.length === 0 || name.length > 128)) {
      return NextResponse.json(
        { error: "name must be 1-128 characters" },
        { status: 400 }
      );
    }

    if (description !== undefined && (typeof description !== "string" || description.length > 512)) {
      return NextResponse.json(
        { error: "description must be at most 512 characters" },
        { status: 400 }
      );
    }

    const updates: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    if (enabled !== undefined) {
      updates.push("enabled = :enabled");
      values[":enabled"] = enabled;
    }
    if (name !== undefined) {
      updates.push("#n = :name");
      names["#n"] = "name";
      values[":name"] = name;
    }
    if (url !== undefined) {
      updates.push("#u = :url");
      names["#u"] = "url";
      values[":url"] = url;
    }
    if (description !== undefined) {
      updates.push("description = :desc");
      values[":desc"] = description;
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 }
      );
    }

    try {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: DEPT_MCP_CONFIG_TABLE,
          Key: marshall({ PK: scopeToPK(validated.scope), SK: `MKTPLACE#${validated.id}` }),
          UpdateExpression: `SET ${updates.join(", ")}`,
          ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
          ...(Object.keys(names).length > 0 && {
            ExpressionAttributeNames: names,
          }),
          ExpressionAttributeValues: marshall(values),
        })
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return NextResponse.json(
          { error: `Marketplace '${validated.id}' not found in scope '${validated.scope}'` },
          { status: 404 }
        );
      }
      throw err;
    }

    return NextResponse.json({
      success: true,
      message: `Marketplace ${validated.id} updated`,
    });
  } catch (err) {
    console.error(
      "[admin/mcp/marketplaces] PUT",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { id, scope } = body as { id: string; scope: string };

    if (!id || !scope) {
      return NextResponse.json(
        { error: "id and scope are required" },
        { status: 400 }
      );
    }

    const validated = validateIdAndScope(id, scope);
    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    await dynamodb.send(
      new DeleteItemCommand({
        TableName: DEPT_MCP_CONFIG_TABLE,
        Key: marshall({ PK: scopeToPK(validated.scope), SK: `MKTPLACE#${validated.id}` }),
      })
    );

    return NextResponse.json({
      success: true,
      message: `Marketplace ${validated.id} removed from ${validated.scope}`,
    });
  } catch (err) {
    console.error(
      "[admin/mcp/marketplaces] DELETE",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
