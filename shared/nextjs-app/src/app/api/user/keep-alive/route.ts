import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const TABLE_NAME = process.env.USER_VOLUMES_TABLE ?? "cc-user-volumes";

const dynamodb = new DynamoDBClient({ region });

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const userId = body.userId as string | undefined;

    // Users can only extend their own idle timer, admins can extend any
    const targetUserId = session.user.isAdmin && userId ? userId : session.user.email;

    if (!targetUserId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    // Extend keep_alive_until by 1 hour from now
    const extendedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await dynamodb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        userId: { S: targetUserId },
      },
      UpdateExpression: "SET keep_alive_until = :until, updated_at = :now",
      ExpressionAttributeValues: {
        ":until": { S: extendedUntil },
        ":now": { S: new Date().toISOString() },
      },
    }));

    return NextResponse.json({
      success: true,
      extendedUntil,
    });
  } catch (err) {
    console.error("[user/keep-alive] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
