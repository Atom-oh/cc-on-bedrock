import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCognitoUser } from "@/lib/aws-clients";
import {
  DynamoDBClient,
  ScanCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { EC2Client, ModifyVolumeCommand } from "@aws-sdk/client-ec2";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const USER_VOLUMES_TABLE = process.env.USER_VOLUMES_TABLE ?? "cc-user-volumes";

const dynamodb = new DynamoDBClient({ region });
const ec2 = new EC2Client({ region });

interface PendingResizeRequest {
  userId: string;
  userEmail: string;
  department: string;
  currentSizeGb: number;
  requestedSizeGb: number;
  reason: string;
  status: string;
  requestedAt: string;
  volumeId?: string;
}

// GET: List all pending resize requests (admin only)
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status") ?? "resize_pending";

  try {
    const result = await dynamodb.send(
      new ScanCommand({
        TableName: USER_VOLUMES_TABLE,
        FilterExpression: "resizeStatus = :status",
        ExpressionAttributeValues: {
          ":status": { S: statusFilter },
        },
      })
    );

    const requests: PendingResizeRequest[] = (result.Items ?? []).map((item) => {
      const u = unmarshall(item);
      return {
        userId: u.user_id ?? "unknown",
        userEmail: u.userEmail ?? "",
        department: u.department ?? "default",
        currentSizeGb: Number(u.currentSizeGb ?? u.ebsSizeGb ?? 20),
        requestedSizeGb: Number(u.requestedSizeGb ?? 0),
        reason: u.resizeReason ?? "",
        status: u.resizeStatus ?? "unknown",
        requestedAt: u.resizeRequestedAt ?? "",
        volumeId: u.volumeId,
      };
    });

    // Sort by requestedAt (newest first)
    requests.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

    return NextResponse.json({
      success: true,
      data: requests,
      total: requests.length,
    });
  } catch (err) {
    console.error("[admin/ebs-resize] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

// POST: Approve or reject resize request (admin only)
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { userId, approved } = body as {
      userId: string;
      approved: boolean;
    };

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    if (typeof approved !== "boolean") {
      return NextResponse.json({ error: "approved (boolean) is required" }, { status: 400 });
    }

    // Verify target user uses EBS storage
    const targetUser = await getCognitoUser(userId);
    if (targetUser.storageType !== "ebs") {
      return NextResponse.json(
        { success: false, error: "Target user does not use EBS storage" },
        { status: 400 }
      );
    }

    // Get the current resize request
    const existingResult = await dynamodb.send(
      new GetItemCommand({
        TableName: USER_VOLUMES_TABLE,
        Key: { user_id: { S: userId } },
      })
    );

    if (!existingResult.Item) {
      return NextResponse.json({ error: "User volume record not found" }, { status: 404 });
    }

    const item = unmarshall(existingResult.Item);

    if (item.resizeStatus !== "resize_pending") {
      return NextResponse.json(
        { error: "No pending resize request for this user" },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const newStatus = approved ? "approved" : "rejected";

    // Update the request status
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: USER_VOLUMES_TABLE,
        Key: { user_id: { S: userId } },
        UpdateExpression: `SET
          resizeStatus = :status,
          resizeUpdatedAt = :now,
          resizeApprovedBy = :admin`,
        ExpressionAttributeValues: {
          ":status": { S: newStatus },
          ":now": { S: now },
          ":admin": { S: session.user.email },
        },
      })
    );

    // If approved, call ec2:ModifyVolume directly to resize
    if (approved && item.volumeId) {
      try {
        await ec2.send(
          new ModifyVolumeCommand({
            VolumeId: item.volumeId,
            Size: item.requestedSizeGb,
          })
        );
        console.log(`[admin/ebs-resize] ModifyVolume ${item.volumeId} → ${item.requestedSizeGb}GB for ${userId}`);
      } catch (ec2Err) {
        console.error("[admin/ebs-resize] ModifyVolume failed:", ec2Err);
        // Rollback DDB status to resize_pending so admin can retry
        await dynamodb.send(new UpdateItemCommand({
          TableName: USER_VOLUMES_TABLE,
          Key: { userId: { S: userId } },
          UpdateExpression: "SET resizeStatus = :status",
          ExpressionAttributeValues: { ":status": { S: "resize_pending" } },
        })).catch(() => {});
        return NextResponse.json(
          { success: false, error: `Volume resize failed: ${ec2Err instanceof Error ? ec2Err.message : "Unknown error"}` },
          { status: 500 }
        );
      }
    } else if (approved && !item.volumeId) {
      console.log(`[admin/ebs-resize] Approved resize for ${userId} (volume will be resized on next start)`);
    }

    return NextResponse.json({
      success: true,
      data: {
        userId,
        status: newStatus,
        requestedSizeGb: item.requestedSizeGb,
        approvedBy: session.user.email,
        updatedAt: now,
        volumeResizeTriggered: approved && !!item.volumeId,
      },
    });
  } catch (err) {
    console.error("[admin/ebs-resize] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
