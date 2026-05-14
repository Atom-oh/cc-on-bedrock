import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_MCP_CONFIG_TABLE = process.env.DEPT_MCP_CONFIG_TABLE ?? "cc-dept-mcp-config";
const MCP_CATALOG_TABLE = process.env.MCP_CATALOG_TABLE ?? "cc-mcp-catalog";
const dynamodb = new DynamoDBClient({ region });

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const groups = session.user.groups ?? [];
  const isDeptManager = groups.includes("dept-manager") || groups.includes("admin");
  const isAdmin = groups.includes("admin");
  if (!isDeptManager) {
    return NextResponse.json({ error: "Dept-manager access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const deptParam = searchParams.get("department");

  // Admin can query any department; dept-manager is scoped to their own
  const userDept = session.user.email?.split("@")[1]?.split(".")[0] ?? "default";
  const department = isAdmin ? (deptParam ?? userDept) : userDept;

  if (!department) {
    return NextResponse.json({ error: "department is required" }, { status: 400 });
  }

  // Cross-department guard is already enforced above by deriving `department` from `userDept`
  // for non-admins (`isAdmin ? deptParam : userDept`). PR #11's redundant secondary check was
  // removed during merge with feat/dept-mcp-completion@91b06e5 which introduced the cleaner pattern.

  try {
    // Get gateway status
    const gwResult = await dynamodb.send(new GetItemCommand({
      TableName: DEPT_MCP_CONFIG_TABLE,
      Key: marshall({ PK: `DEPT#${department}`, SK: "GATEWAY" }),
    }));
    const gateway = gwResult.Item ? unmarshall(gwResult.Item) : null;
    const gatewayStatus = gateway?.status ?? "none";

    // Get MCP assignments
    const assignResult = await dynamodb.send(new QueryCommand({
      TableName: DEPT_MCP_CONFIG_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: marshall({
        ":pk": `DEPT#${department}`,
        ":prefix": "MCP#",
      }),
    }));

    const assignments = await Promise.all(
      (assignResult.Items ?? []).map(async (item) => {
        const u = unmarshall(item);
        const catalogId = u.SK?.replace("MCP#", "") ?? "";

        // Lookup catalog for name/category
        let name = catalogId;
        let category = "unknown";
        try {
          const catResult = await dynamodb.send(new GetItemCommand({
            TableName: MCP_CATALOG_TABLE,
            Key: marshall({ PK: `CATALOG#${catalogId}`, SK: "META" }),
          }));
          if (catResult.Item) {
            const cat = unmarshall(catResult.Item);
            name = cat.name ?? catalogId;
            category = cat.category ?? "unknown";
          }
        } catch { /* catalog lookup failure is non-fatal */ }

        return {
          catalogId,
          name,
          category,
          enabled: u.enabled ?? true,
        };
      })
    );

    // Get marketplaces (common + department)
    const [commonMktResult, deptMktResult] = await Promise.all([
      dynamodb.send(new QueryCommand({
        TableName: DEPT_MCP_CONFIG_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: marshall({ ":pk": "COMMON", ":prefix": "MKTPLACE#" }),
      })),
      dynamodb.send(new QueryCommand({
        TableName: DEPT_MCP_CONFIG_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: marshall({ ":pk": `DEPT#${department}`, ":prefix": "MKTPLACE#" }),
      })),
    ]);

    const toMarketplace = (items: Record<string, unknown>[], scope: string) =>
      items.map((m) => ({
        id: (m.SK as string)?.replace("MKTPLACE#", "") ?? "",
        url: (m.url as string) ?? "",
        name: (m.name as string) ?? "",
        enabled: (m.enabled as boolean) ?? true,
        scope,
      }));

    const marketplaces = [
      ...toMarketplace((commonMktResult.Items ?? []).map((i) => unmarshall(i)), "common"),
      ...toMarketplace((deptMktResult.Items ?? []).map((i) => unmarshall(i)), department),
    ];

    return NextResponse.json({
      success: true,
      data: { assignments, gatewayStatus, marketplaces },
    });
  } catch (err) {
    console.error("[dept/mcp] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
