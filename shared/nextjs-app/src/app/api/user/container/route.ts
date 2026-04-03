import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  startContainer,
  stopContainer,
  listContainers,
  registerContainerRoute,
  describeContainer,
  deregisterContainerRoute,
  getCognitoUser,
} from "@/lib/aws-clients";
import {
  startInstance,
  stopInstance,
  listInstances,
} from "@/lib/ec2-clients";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const computeMode = process.env.COMPUTE_MODE ?? "ec2";
const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
const dynamodb = new DynamoDBClient({ region });

const VALID_TIERS = ["light", "standard", "power"] as const;
type ResourceTier = (typeof VALID_TIERS)[number];

async function getDeptAllowedTiers(department: string): Promise<ResourceTier[]> {
  try {
    const result = await dynamodb.send(
      new GetItemCommand({
        TableName: DEPT_BUDGETS_TABLE,
        Key: { dept_id: { S: department } },
      })
    );
    if (result.Item) {
      const item = unmarshall(result.Item);
      if (item.allowedTiers && Array.isArray(item.allowedTiers)) {
        return item.allowedTiers.filter((t: string) =>
          VALID_TIERS.includes(t as ResourceTier)
        ) as ResourceTier[];
      }
    }
  } catch (err) {
    console.warn("[user/container] Failed to fetch dept policy:", err);
  }
  // Default: allow all tiers
  return ["light", "standard", "power"];
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const user = session.user;
  const action = req.nextUrl.searchParams.get("action");

  if (action === "dept-policy") {
    const department = ((user as unknown as Record<string, string>).department) ?? "";
    const allowedTiers = department ? await getDeptAllowedTiers(department) : ["light", "standard", "power"];
    return NextResponse.json({ success: true, data: { allowedTiers } });
  }

  // Verify actual Cognito subdomain (bypasses stale JWT cache)
  if (action === "verify") {
    try {
      const cognitoUser = await getCognitoUser(user.email);
      return NextResponse.json({
        success: true,
        data: { subdomain: cognitoUser.subdomain || null },
      });
    } catch {
      return NextResponse.json({
        success: true,
        data: { subdomain: null },
      });
    }
  }

  if (!user.subdomain) {
    return NextResponse.json({ success: true, data: null });
  }
  try {
    if (computeMode === "ec2") {
      const instances = await listInstances();
      const userInstance = instances.find(
        (i) => i.subdomain === user.subdomain && (i.status === "running" || i.status === "pending")
      );
      // Map to ContainerInfo-like shape for UI compatibility
      if (userInstance) {
        return NextResponse.json({ success: true, data: {
          taskArn: userInstance.instanceId,
          taskId: userInstance.instanceId,
          status: userInstance.status.toUpperCase(),
          desiredStatus: userInstance.status.toUpperCase(),
          username: userInstance.username,
          subdomain: userInstance.subdomain,
          containerOs: "ubuntu",
          resourceTier: "standard",
          securityPolicy: userInstance.securityPolicy,
          privateIp: userInstance.privateIp,
          healthStatus: userInstance.status === "running" ? "HEALTHY" : "UNKNOWN",
        }});
      }
      return NextResponse.json({ success: true, data: null });
    }

    const containers = await listContainers();
    const userContainer = containers.find(
      (c) => c.subdomain === user.subdomain &&
        (c.status === "RUNNING" || c.status === "PENDING" || c.status === "PROVISIONING")
    );
    return NextResponse.json({ success: true, data: userContainer ?? null });
  } catch (err) {
    console.error("[user/container GET]", err);
    return NextResponse.json({ error: "Failed to fetch container" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const user = session.user;
  if (!user.subdomain) {
    return NextResponse.json({ error: "No subdomain assigned to user" }, { status: 400 });
  }

  try {
    const body = await req.json();
    const { action, taskArn, resourceTier: requestedTier } = body;

    if (action === "start") {
      if (computeMode === "ec2") {
        const result = await startInstance({
          subdomain: user.subdomain,
          username: user.email,
          department: (user as unknown as Record<string, string>).department ?? "default",
          securityPolicy: (user.securityPolicy ?? "restricted") as "open" | "restricted" | "locked",
        });
        return NextResponse.json({ success: true, data: { taskArn: result.instanceId } });
      }

      // ECS mode
      const containers = await listContainers();
      const existingContainer = containers.find(
        (c) =>
          c.subdomain === user.subdomain &&
          (c.status === "RUNNING" || c.status === "PENDING" || c.status === "PROVISIONING")
      );

      if (existingContainer) {
        return NextResponse.json(
          { success: false, error: "You already have a running container" },
          { status: 409 }
        );
      }

      const tierToUse: ResourceTier = VALID_TIERS.includes(requestedTier)
        ? requestedTier
        : (user.resourceTier as ResourceTier) ?? "standard";

      const department = "default";
      const allowedTiers = await getDeptAllowedTiers(department);

      if (!allowedTiers.includes(tierToUse)) {
        return NextResponse.json(
          {
            success: false,
            error: `Tier "${tierToUse}" is not allowed for your department. Allowed: ${allowedTiers.join(", ")}`,
          },
          { status: 403 }
        );
      }

      const newTaskArn = await startContainer({
        username: user.email,
        subdomain: user.subdomain,
        department,
        containerOs: user.containerOs ?? "ubuntu",
        resourceTier: tierToUse,
        securityPolicy: user.securityPolicy ?? "restricted",
        storageType: user.storageType ?? "efs",
      });

      setTimeout(async () => {
        try {
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            const info = await describeContainer(newTaskArn);
            if (info?.privateIp) {
              await registerContainerRoute(user.subdomain!, info.privateIp);
              break;
            }
          }
        } catch (err) {
          console.error("[user/container] Route register failed:", err);
        }
      }, 2000);

      return NextResponse.json({ success: true, data: { taskArn: newTaskArn } });
    }

    if (action === "stop") {
      if (computeMode === "ec2") {
        await stopInstance(user.subdomain, "Stopped by user");
        return NextResponse.json({ success: true });
      }

      if (!taskArn) {
        return NextResponse.json({ error: "taskArn required for stop action" }, { status: 400 });
      }

      // Verify this container belongs to the user
      const containers = await listContainers();
      const userContainer = containers.find(
        (c) => c.taskArn === taskArn && c.subdomain === user.subdomain
      );

      if (!userContainer) {
        return NextResponse.json(
          { success: false, error: "Container not found or not owned by you" },
          { status: 403 }
        );
      }

      // Deregister route before stopping
      try {
        await deregisterContainerRoute(user.subdomain);
      } catch (err) {
        console.warn("[user/container] Route deregister:", err);
      }

      // EBS mode: get volume ID from task BEFORE stopping (attachment info is lost after stop)
      const serverStorageType = process.env.STORAGE_TYPE ?? "ebs";
      let ebsVolumeId: string | undefined;
      if (serverStorageType === "ebs") {
        try {
          const { ECSClient, DescribeTasksCommand: DescTasks } = await import("@aws-sdk/client-ecs");
          const ecs = new ECSClient({ region });
          const desc = await ecs.send(new DescTasks({
            cluster: process.env.ECS_CLUSTER_NAME ?? "cc-on-bedrock-devenv",
            tasks: [taskArn],
          }));
          const ebsAttachment = desc.tasks?.[0]?.attachments?.find(a => a.type === "AmazonElasticBlockStorage");
          ebsVolumeId = ebsAttachment?.details?.find(d => d.name === "volumeId")?.value;
          if (ebsVolumeId) console.log(`[user/container] Found EBS volume ${ebsVolumeId} for ${user.subdomain}`);
        } catch (err) {
          console.warn("[user/container] Failed to get EBS volume ID:", err);
        }
      }

      await stopContainer({ taskArn, reason: "Stopped by user" });

      // EBS mode: trigger snapshot with volume ID
      if (serverStorageType === "ebs" && ebsVolumeId) {
        try {
          const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
          const lambda = new LambdaClient({ region });
          await lambda.send(new InvokeCommand({
            FunctionName: process.env.EBS_LIFECYCLE_LAMBDA ?? "cc-on-bedrock-ebs-lifecycle",
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify({
              action: "snapshot_and_detach",
              user_id: user.subdomain,
              volume_id: ebsVolumeId,
            })),
          }));
          console.log(`[user/container] EBS snapshot triggered for ${user.subdomain} (vol: ${ebsVolumeId})`);
        } catch (err) {
          console.warn("[user/container] EBS snapshot trigger failed:", err);
        }
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[user/container] POST", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
