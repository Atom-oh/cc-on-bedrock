import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const USER_VOLUMES_TABLE = process.env.USER_VOLUMES_TABLE ?? "cc-user-volumes";

const dynamodb = new DynamoDBClient({ region });

const ALLOWED_SIZES = [40, 60, 100] as const;
type AllowedSize = (typeof ALLOWED_SIZES)[number];

interface ResizeRequest {
  userId: string;
  currentSizeGb: number;
  requestedSizeGb: AllowedSize;
  reason: string;
  status: "resize_pending" | "approved" | "rejected" | "completed";
  requestedAt: string;
  updatedAt?: string;
  approvedBy?: string;
}

// GET: Check user's current EBS resize request status
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.storageType !== "ebs") {
    return NextResponse.json(
      { success: false, error: "EBS storage not configured for this user", storageType: session.user.storageType ?? "efs" },
      { status: 400 }
    );
  }

  const userId = session.user.subdomain ?? session.user.email;

  try {
    const result = await dynamodb.send(
      new GetItemCommand({
        TableName: USER_VOLUMES_TABLE,
        Key: { user_id: { S: userId } },
      })
    );

    if (!result.Item) {
      return NextResponse.json({
        success: true,
        data: {
          userId,
          currentSizeGb: 20, // Default EBS size
          resizeRequest: null,
        },
      });
    }

    const item = unmarshall(result.Item);
    return NextResponse.json({
      success: true,
      data: {
        userId,
        currentSizeGb: item.currentSizeGb ?? item.ebsSizeGb ?? 20,
        volumeId: item.volumeId ?? null,
        resizeRequest: item.resizeStatus
          ? {
              requestedSizeGb: item.requestedSizeGb,
              reason: item.resizeReason,
              status: item.resizeStatus,
              requestedAt: item.resizeRequestedAt,
              updatedAt: item.resizeUpdatedAt,
              approvedBy: item.resizeApprovedBy,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("[user/ebs-resize] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

// POST: User requests EBS resize
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.storageType !== "ebs") {
    return NextResponse.json(
      { success: false, error: "EBS storage not configured for this user", storageType: session.user.storageType ?? "efs" },
      { status: 400 }
    );
  }

  const userId = session.user.subdomain ?? session.user.email;

  try {
    const body = await req.json();
    const { requestedSizeGb, reason } = body as {
      requestedSizeGb: number;
      reason: string;
    };

    // Validate requested size
    if (!ALLOWED_SIZES.includes(requestedSizeGb as AllowedSize)) {
      return NextResponse.json(
        { error: `Invalid size. Allowed sizes: ${ALLOWED_SIZES.join(", ")} GB` },
        { status: 400 }
      );
    }

    if (!reason || reason.trim().length < 10) {
      return NextResponse.json(
        { error: "Reason must be at least 10 characters" },
        { status: 400 }
      );
    }

    // Get current volume info
    const existingResult = await dynamodb.send(
      new GetItemCommand({
        TableName: USER_VOLUMES_TABLE,
        Key: { user_id: { S: userId } },
      })
    );

    const existingItem = existingResult.Item ? unmarshall(existingResult.Item) : null;
    const currentSizeGb = existingItem?.currentSizeGb ?? existingItem?.ebsSizeGb ?? 20;

    // Cannot request smaller size
    if (requestedSizeGb <= currentSizeGb) {
      return NextResponse.json(
        { error: `Requested size must be larger than current size (${currentSizeGb} GB)` },
        { status: 400 }
      );
    }

    // Check if there's already a pending request
    if (existingItem?.resizeStatus === "resize_pending") {
      return NextResponse.json(
        { error: "You already have a pending resize request" },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();

    // Update or create volume record with resize request
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: USER_VOLUMES_TABLE,
        Key: { user_id: { S: userId } },
        UpdateExpression: `SET
          requestedSizeGb = :reqSize,
          resizeReason = :reason,
          resizeStatus = :status,
          resizeRequestedAt = :now,
          currentSizeGb = if_not_exists(currentSizeGb, :defaultSize),
          userEmail = :email,
          department = :dept`,
        ExpressionAttributeValues: {
          ":reqSize": { N: String(requestedSizeGb) },
          ":reason": { S: reason.trim() },
          ":status": { S: "resize_pending" },
          ":now": { S: now },
          ":defaultSize": { N: String(currentSizeGb) },
          ":email": { S: session.user.email },
          ":dept": { S: "default" }, // Could be extended to use actual department
        },
      })
    );

    return NextResponse.json({
      success: true,
      data: {
        userId,
        requestedSizeGb,
        currentSizeGb,
        status: "resize_pending",
        requestedAt: now,
      },
    });
  } catch (err) {
    console.error("[user/ebs-resize] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

// DELETE: Cancel pending resize request
export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.storageType !== "ebs") {
    return NextResponse.json(
      { success: false, error: "EBS storage not configured for this user", storageType: session.user.storageType ?? "efs" },
      { status: 400 }
    );
  }

  const userId = session.user.subdomain ?? session.user.email;

  try {
    // Check if there's a pending request
    const existingResult = await dynamodb.send(
      new GetItemCommand({
        TableName: USER_VOLUMES_TABLE,
        Key: { user_id: { S: userId } },
      })
    );

    if (!existingResult.Item) {
      return NextResponse.json({ error: "No resize request found" }, { status: 404 });
    }

    const item = unmarshall(existingResult.Item);
    if (item.resizeStatus !== "resize_pending") {
      return NextResponse.json(
        { error: "Can only cancel pending requests" },
        { status: 400 }
      );
    }

    // Remove resize request fields
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: USER_VOLUMES_TABLE,
        Key: { user_id: { S: userId } },
        UpdateExpression: "REMOVE requestedSizeGb, resizeReason, resizeStatus, resizeRequestedAt",
      })
    );

    return NextResponse.json({
      success: true,
      message: "Resize request cancelled",
    });
  } catch (err) {
    console.error("[user/ebs-resize] DELETE", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
