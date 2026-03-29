import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listContainers } from "@/lib/aws-clients";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const ecsCluster = process.env.ECS_CLUSTER_NAME ?? "cc-on-bedrock-cluster";
const cloudwatch = new CloudWatchClient({ region });
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

  const storageType = user.storageType ?? "efs";

  try {
    // Find user's running container
    const containers = await listContainers();
    const container = containers.find(
      (c) => c.subdomain === user.subdomain && c.status === "RUNNING"
    );

    if (!container) {
      // No running container — return volume info from DynamoDB if EBS
      if (storageType === "ebs") {
        const volumeInfo = await getEbsVolumeInfo(user.subdomain);
        return NextResponse.json({
          success: true,
          data: {
            storageType,
            total: (volumeInfo?.sizeGb ?? 20) * 1024 * 1024 * 1024,
            used: 0,
            available: (volumeInfo?.sizeGb ?? 20) * 1024 * 1024 * 1024,
            usagePercent: 0,
            mountPath: "/home/coder",
          },
        });
      }
      return NextResponse.json(
        { success: false, error: "No running container found" },
        { status: 404 }
      );
    }

    // Get disk I/O from CloudWatch Container Insights as usage proxy
    const clusterName = ecsCluster.split("/").pop() ?? ecsCluster;
    const taskId = container.taskId;
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // Get EphemeralStorageUtilized and EphemeralStorageReserved if available
    const [utilizedResult, reservedResult] = await Promise.all([
      cloudwatch.send(new GetMetricStatisticsCommand({
        Namespace: "ECS/ContainerInsights",
        MetricName: "EphemeralStorageUtilized",
        Dimensions: [
          { Name: "ClusterName", Value: clusterName },
          { Name: "TaskId", Value: taskId },
        ],
        StartTime: fiveMinAgo,
        EndTime: now,
        Period: 300,
        Statistics: ["Average"],
      })).catch(() => null),
      cloudwatch.send(new GetMetricStatisticsCommand({
        Namespace: "ECS/ContainerInsights",
        MetricName: "EphemeralStorageReserved",
        Dimensions: [
          { Name: "ClusterName", Value: clusterName },
          { Name: "TaskId", Value: taskId },
        ],
        StartTime: fiveMinAgo,
        EndTime: now,
        Period: 300,
        Statistics: ["Average"],
      })).catch(() => null),
    ]);

    const utilized = utilizedResult?.Datapoints?.[0]?.Average ?? 0;
    const reserved = reservedResult?.Datapoints?.[0]?.Average ?? 0;

    if (storageType === "ebs") {
      const volumeInfo = await getEbsVolumeInfo(user.subdomain);
      const totalBytes = (volumeInfo?.sizeGb ?? 20) * 1024 * 1024 * 1024;
      // Use CloudWatch data if available, otherwise estimate from EBS volume info
      const usedBytes = utilized > 0 ? utilized * 1024 * 1024 : 0;
      const availableBytes = totalBytes - usedBytes;
      const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

      return NextResponse.json({
        success: true,
        data: {
          storageType,
          total: totalBytes,
          used: usedBytes,
          available: Math.max(0, availableBytes),
          usagePercent: Math.min(100, usagePercent),
          mountPath: "/home/coder",
        },
      });
    }

    // EFS mode: show usage only (no limit)
    const usedBytes = utilized > 0 ? utilized * 1024 * 1024 : 0;
    return NextResponse.json({
      success: true,
      data: {
        storageType,
        total: 0,
        used: usedBytes,
        available: 0,
        usagePercent: 0,
        mountPath: "/home/coder",
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
      return { sizeGb: item.currentSizeGb ?? item.ebsSizeGb ?? 20 };
    }
  } catch { /* ignore */ }
  return null;
}
