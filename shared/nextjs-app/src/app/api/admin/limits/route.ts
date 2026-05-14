import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

// ADR-014/015: admin CRUD for normalized-token limits in cc-on-bedrock-limits.
//
// Schema:
//   PK = "USER#{sub}" | "DEPT#{dept}"
//   SK = "LIMIT#{daily|weekly|monthly}"
//   attrs: max_normalized (number), updatedAt (string)

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const LIMITS_TABLE = process.env.LIMITS_TABLE ?? "cc-on-bedrock-limits";
const PERIODS = new Set(["daily", "weekly", "monthly"]);

const dynamo = new DynamoDBClient({ region });

type LimitItem = {
  entity: "USER" | "DEPT";
  key: string;
  period: "daily" | "weekly" | "monthly";
  maxNormalized: number;
  updatedAt?: string;
};

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return { error: "Authentication required", status: 401 } as const;
  if (!session.user.isAdmin) return { error: "Admin access required", status: 403 } as const;
  return { session } as const;
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const out = await dynamo.send(new ScanCommand({
    TableName: LIMITS_TABLE,
    FilterExpression: "begins_with(SK, :p)",
    ExpressionAttributeValues: marshall({ ":p": "LIMIT#" }),
  }));

  const items: LimitItem[] = (out.Items ?? []).map((raw) => {
    const u = unmarshall(raw);
    const [, period] = String(u.SK ?? "").split("#");
    const pk = String(u.PK ?? "");
    const entity = pk.startsWith("USER#") ? "USER" : "DEPT";
    const key = pk.slice(5);
    return {
      entity,
      key,
      period: period as LimitItem["period"],
      maxNormalized: Number(u.max_normalized ?? 0),
      updatedAt: u.updatedAt ? String(u.updatedAt) : undefined,
    };
  });

  return NextResponse.json({ limits: items });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Partial<LimitItem>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { entity, key, period, maxNormalized } = body;
  if (entity !== "USER" && entity !== "DEPT") {
    return NextResponse.json({ error: "entity must be USER or DEPT" }, { status: 400 });
  }
  if (!key || typeof key !== "string") {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }
  if (!period || !PERIODS.has(period)) {
    return NextResponse.json({ error: "period must be daily|weekly|monthly" }, { status: 400 });
  }
  const max = Number(maxNormalized);
  if (!Number.isFinite(max) || max < 0) {
    return NextResponse.json({ error: "maxNormalized must be >= 0" }, { status: 400 });
  }

  await dynamo.send(new PutItemCommand({
    TableName: LIMITS_TABLE,
    Item: marshall({
      PK: `${entity}#${key}`,
      SK: `LIMIT#${period}`,
      max_normalized: max,
      updatedAt: new Date().toISOString(),
    }),
  }));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(req.url);
  const entity = searchParams.get("entity");
  const key = searchParams.get("key");
  const period = searchParams.get("period");
  if ((entity !== "USER" && entity !== "DEPT") || !key || !period || !PERIODS.has(period)) {
    return NextResponse.json({ error: "entity/key/period required" }, { status: 400 });
  }

  await dynamo.send(new DeleteItemCommand({
    TableName: LIMITS_TABLE,
    Key: marshall({ PK: `${entity}#${key}`, SK: `LIMIT#${period}` }),
  }));
  return NextResponse.json({ ok: true });
}
