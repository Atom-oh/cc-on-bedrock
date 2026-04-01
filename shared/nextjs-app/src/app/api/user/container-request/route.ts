import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "crypto";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const APPROVAL_TABLE = process.env.APPROVAL_TABLE ?? "cc-on-bedrock-approval-requests";

const dynamodb = new DynamoDBClient({ region });

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const result = await dynamodb.send(
      new ScanCommand({
        TableName: APPROVAL_TABLE,
        FilterExpression: "email = :email",
        ExpressionAttributeValues: {
          ":email": { S: session.user.email },
        },
      })
    );

    const items = (result.Items ?? []).map((item) => unmarshall(item));
    items.sort((a, b) => (b.requestedAt ?? "").localeCompare(a.requestedAt ?? ""));

    const latest = items[0] ?? null;

    return NextResponse.json({
      success: true,
      data: latest,
    });
  } catch (err) {
    console.error("[user/container-request] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { resourceTier, storageType, volumeSize } = body as {
      resourceTier: string;
      storageType: string;
      volumeSize: number;
    };

    if (!["light", "standard", "power"].includes(resourceTier)) {
      return NextResponse.json({ error: "Invalid resourceTier" }, { status: 400 });
    }
    if (!["ebs", "efs"].includes(storageType)) {
      return NextResponse.json({ error: "Invalid storageType" }, { status: 400 });
    }
    if (typeof volumeSize !== "number" || volumeSize < 20 || volumeSize > 100) {
      return NextResponse.json({ error: "volumeSize must be between 20 and 100" }, { status: 400 });
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();

    await dynamodb.send(
      new PutItemCommand({
        TableName: APPROVAL_TABLE,
        Item: {
          PK: { S: `REQUEST#${requestId}` },
          SK: { S: "META" },
          requestId: { S: requestId },
          email: { S: session.user.email },
          department: { S: (session.user as unknown as Record<string, unknown>).department as string ?? "default" },
          resourceTier: { S: resourceTier },
          storageType: { S: storageType },
          volumeSize: { N: String(volumeSize) },
          containerOs: { S: "ubuntu" },
          status: { S: "pending" },
          requestedAt: { S: now },
        },
      })
    );

    return NextResponse.json({
      success: true,
      data: { requestId },
    });
  } catch (err) {
    console.error("[user/container-request] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
