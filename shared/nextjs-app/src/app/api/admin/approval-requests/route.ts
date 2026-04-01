import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { updateCognitoUserAttribute } from "@/lib/aws-clients";
import { emailToSubdomain } from "@/lib/utils";
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const APPROVAL_TABLE = process.env.APPROVAL_TABLE ?? "cc-on-bedrock-approval-requests";

const dynamodb = new DynamoDBClient({ region });

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const result = await dynamodb.send(
      new ScanCommand({
        TableName: APPROVAL_TABLE,
      })
    );

    const requests = (result.Items ?? []).map((item) => {
      const u = unmarshall(item);
      return {
        requestId: u.requestId ?? "",
        email: u.email ?? "",
        department: u.department ?? "default",
        resourceTier: u.resourceTier ?? "standard",
        storageType: u.storageType ?? "efs",
        volumeSize: Number(u.volumeSize ?? 20),
        containerOs: u.containerOs ?? "ubuntu",
        status: u.status ?? "pending",
        requestedAt: u.requestedAt ?? "",
      };
    });

    requests.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

    return NextResponse.json({
      success: true,
      data: requests,
    });
  } catch (err) {
    console.error("[admin/approval-requests] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

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
    const { requestId, action, subdomain } = body as {
      requestId: string;
      action: "approve" | "reject" | "assign";
      subdomain?: string;
    };

    if (!requestId) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    if (!["approve", "reject", "assign"].includes(action)) {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const pk = `REQUEST#${requestId}`;
    const now = new Date().toISOString();

    if (action === "approve") {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: APPROVAL_TABLE,
          Key: { PK: { S: pk }, SK: { S: "META" } },
          UpdateExpression: "SET #s = :status, approvedBy = :admin, approvedAt = :now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":status": { S: "approved" },
            ":admin": { S: session.user.email },
            ":now": { S: now },
          },
        })
      );

      return NextResponse.json({ success: true, data: { requestId, status: "approved" } });
    }

    if (action === "reject") {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: APPROVAL_TABLE,
          Key: { PK: { S: pk }, SK: { S: "META" } },
          UpdateExpression: "SET #s = :status, rejectedBy = :admin, rejectedAt = :now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":status": { S: "rejected" },
            ":admin": { S: session.user.email },
            ":now": { S: now },
          },
        })
      );

      return NextResponse.json({ success: true, data: { requestId, status: "rejected" } });
    }

    if (action === "assign") {
      const scanResult = await dynamodb.send(
        new ScanCommand({
          TableName: APPROVAL_TABLE,
          FilterExpression: "requestId = :rid",
          ExpressionAttributeValues: {
            ":rid": { S: requestId },
          },
        })
      );

      const items = (scanResult.Items ?? []).map((item) => unmarshall(item));
      const request = items[0];

      if (!request) {
        return NextResponse.json({ error: "Request not found" }, { status: 404 });
      }

      if (request.status !== "approved") {
        return NextResponse.json({ error: "Request must be approved before assignment" }, { status: 400 });
      }

      const email = request.email as string;
      const assignedSubdomain = subdomain ?? emailToSubdomain(email);

      const cognitoUsername = email;
      await updateCognitoUserAttribute(cognitoUsername, "custom:subdomain", assignedSubdomain);
      await updateCognitoUserAttribute(cognitoUsername, "custom:container_os", request.containerOs ?? "ubuntu");
      await updateCognitoUserAttribute(cognitoUsername, "custom:resource_tier", request.resourceTier ?? "standard");
      await updateCognitoUserAttribute(cognitoUsername, "custom:storage_type", request.storageType ?? "efs");

      await dynamodb.send(
        new UpdateItemCommand({
          TableName: APPROVAL_TABLE,
          Key: { PK: { S: pk }, SK: { S: "META" } },
          UpdateExpression: "SET #s = :status, assignedBy = :admin, assignedAt = :now, subdomain = :sub",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":status": { S: "assigned" },
            ":admin": { S: session.user.email },
            ":now": { S: now },
            ":sub": { S: assignedSubdomain },
          },
        })
      );

      return NextResponse.json({
        success: true,
        data: { requestId, status: "assigned", subdomain: assignedSubdomain },
      });
    }

    return NextResponse.json({ error: "Unhandled action" }, { status: 400 });
  } catch (err) {
    console.error("[admin/approval-requests] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
