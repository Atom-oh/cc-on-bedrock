import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listInstances } from "@/lib/ec2-clients";
import { getEc2Metrics } from "@/lib/cloudwatch-client";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const dynamodb = new DynamoDBClient({ region });
const USER_VOLUMES_TABLE = process.env.USER_VOLUMES_TABLE ?? "cc-user-volumes";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const user = session.user;
  if (!user.subdomain) {
    return NextResponse.json({ error: "No subdomain assigned" }, { status: 400 });
  }

  try {
    const instances = await listInstances();
    const instance = instances.find(
      (i) => i.subdomain === user.subdomain && i.status === "running"
    );

    const volumeInfo = await getEbsVolumeInfo(user.subdomain);
    const totalBytes = (volumeInfo?.sizeGb ?? 30) * 1024 * 1024 * 1024;

    if (!instance) {
      return NextResponse.json({
        success: true,
        data: {
          storageType: "ebs",
          total: totalBytes,
          used: 0,
          available: totalBytes,
          usagePercent: 0,
          mountPath: "/",
        },
      });
    }

    // Get disk_used_percent from CWAgent
    const metrics = await getEc2Metrics(instance.instanceId);
    const usagePercent = metrics.diskUsedPercent;
    const usedBytes = Math.round(totalBytes * (usagePercent / 100));

    return NextResponse.json({
      success: true,
      data: {
        storageType: "ebs",
        total: totalBytes,
        used: usedBytes,
        available: Math.max(0, totalBytes - usedBytes),
        usagePercent: Math.min(100, Math.round(usagePercent)),
        mountPath: "/",
      },
    });
  } catch (err) {
    console.error("[user/disk-usage] GET", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: "Unable to retrieve disk usage" },
      { status: 503 }
    );
  }
}

async function getEbsVolumeInfo(userId: string): Promise<{ sizeGb: number } | null> {
  try {
    const result = await dynamodb.send(
      new GetItemCommand({
        TableName: USER_VOLUMES_TABLE,
        Key: { user_id: { S: userId } },
      })
    );
    if (result.Item) {
      const item = unmarshall(result.Item);
      return { sizeGb: item.currentSizeGb ?? item.ebsSizeGb ?? 30 };
    }
  } catch { /* ignore */ }
  return null;
}
