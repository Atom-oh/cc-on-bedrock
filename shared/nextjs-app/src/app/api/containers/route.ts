import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  startContainer,
  stopContainer,
  listContainers,
  describeContainer,
  registerContainerRoute,
  deregisterContainerRoute,
} from "@/lib/aws-clients";
import {
  startInstance,
  stopInstance,
  terminateInstance,
  listInstances,
} from "@/lib/ec2-clients";
import { EFSClient, DescribeFileSystemsCommand } from "@aws-sdk/client-efs";
import { ECSClient, ExecuteCommandCommand, ListTasksCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";
import type { StartContainerInput, StopContainerInput } from "@/lib/types";
import { startContainerSchema, stopContainerSchema } from "@/lib/validation";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const computeMode = process.env.COMPUTE_MODE ?? "ec2";
const efsClient = new EFSClient({ region });
const ecsExecClient = new ECSClient({ region });
const EFS_ID = process.env.EFS_FILE_SYSTEM_ID ?? "";
const ECS_CLUSTER = process.env.ECS_CLUSTER_NAME ?? "cc-on-bedrock-devenv";

// Cache EFS per-user data (expensive operation via ECS Exec)
let efsUserCache: { data: Record<string, number>; timestamp: number } | null = null;
const EFS_CACHE_TTL = 60000; // 1 minute

async function getPerUserEfsUsage(): Promise<Record<string, number>> {
  // Return cache if fresh
  if (efsUserCache && Date.now() - efsUserCache.timestamp < EFS_CACHE_TTL) {
    return efsUserCache.data;
  }

  try {
    // Find an exec-enabled running task
    const taskList = await ecsExecClient.send(new ListTasksCommand({ cluster: ECS_CLUSTER, maxResults: 10 }));
    if (!taskList.taskArns?.length) return {};

    const tasks = await ecsExecClient.send(new DescribeTasksCommand({
      cluster: ECS_CLUSTER, tasks: taskList.taskArns, include: ["TAGS"],
    }));
    const execTask = tasks.tasks?.find((t) => t.enableExecuteCommand && t.lastStatus === "RUNNING");
    if (!execTask) return {};

    const taskId = execTask.taskArn?.split("/").pop() ?? "";

    // Run du via ECS Exec - use SSM to avoid interactive mode issues
    // Instead, use the EFS describe API for total, and calculate per-container estimate
    const taskCount = tasks.tasks?.filter((t) => t.lastStatus === "RUNNING").length ?? 1;
    const efsResp = await efsClient.send(new DescribeFileSystemsCommand({ FileSystemId: EFS_ID }));
    const totalBytes = efsResp.FileSystems?.[0]?.SizeInBytes?.Value ?? 0;

    // Build per-user map from running tasks with equal share estimate
    const result: Record<string, number> = {};
    for (const t of tasks.tasks ?? []) {
      if (t.lastStatus !== "RUNNING") continue;
      const tags = t.tags ?? [];
      const sub = tags.find((tag) => tag.key === "subdomain")?.value ?? "";
      if (sub) {
        result[sub] = Math.round(totalBytes / taskCount);
      }
    }

    efsUserCache = { data: result, timestamp: Date.now() };
    return result;
  } catch (err) {
    console.error("[EFS] Per-user usage error:", err);
    return {};
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const taskArn = searchParams.get("taskArn");

  try {
    const action = searchParams.get("action");

    // EFS metrics endpoint
    if (action === "efs") {
      if (!EFS_ID) {
        return NextResponse.json({ success: true, data: null });
      }
      const [efsResp, perUser] = await Promise.all([
        efsClient.send(new DescribeFileSystemsCommand({ FileSystemId: EFS_ID })),
        getPerUserEfsUsage(),
      ]);
      const fs = efsResp.FileSystems?.[0];
      return NextResponse.json({
        success: true,
        data: {
          fileSystemId: EFS_ID,
          sizeBytes: fs?.SizeInBytes?.Value ?? 0,
          sizeStandard: fs?.SizeInBytes?.ValueInStandard ?? 0,
          sizeIA: fs?.SizeInBytes?.ValueInIA ?? 0,
          state: fs?.LifeCycleState ?? "unknown",
          numberOfMountTargets: fs?.NumberOfMountTargets ?? 0,
          perUser,
        },
      });
    }

    if (computeMode === "ec2") {
      const instances = await listInstances();
      // Map to ContainerInfo-like shape for UI compatibility
      const mapped = instances.map(i => ({
        taskArn: i.instanceId,
        taskId: i.instanceId,
        status: i.status.toUpperCase(),
        desiredStatus: i.status.toUpperCase(),
        username: i.username,
        subdomain: i.subdomain,
        containerOs: "ubuntu" as const,
        resourceTier: "standard" as const,
        securityPolicy: i.securityPolicy,
        privateIp: i.privateIp,
        healthStatus: i.status === "running" ? "HEALTHY" : "UNKNOWN",
      }));
      if (taskArn) {
        const found = mapped.find(m => m.taskArn === taskArn);
        return NextResponse.json({ success: true, data: found ?? null });
      }
      return NextResponse.json({ success: true, data: mapped });
    }

    if (taskArn) {
      const container = await describeContainer(taskArn);
      if (!container) {
        return NextResponse.json({ success: false, error: "Container not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: container });
    }
    const containers = await listContainers();
    return NextResponse.json({ success: true, data: containers });
  } catch (err) {
    console.error("[containers] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const raw = await req.json();

    if (computeMode === "ec2") {
      const { subdomain, username, department, securityPolicy } = raw as {
        subdomain: string; username: string; department?: string; securityPolicy?: string;
      };
      const result = await startInstance({
        subdomain,
        username,
        department: department ?? "default",
        securityPolicy: (securityPolicy ?? "restricted") as "open" | "restricted" | "locked",
      });
      return NextResponse.json({ success: true, data: { taskArn: result.instanceId } });
    }

    const parsed = startContainerSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    const body = parsed.data;
    const taskArn = await startContainer(body);

    // Route registration runs async but with proper error tracking.
    // Safe on EC2-hosted Next.js (long-lived process); not safe on Lambda/Edge.
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 2000));
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const info = await describeContainer(taskArn);
          if (info?.privateIp) {
            await registerContainerRoute(body.subdomain, info.privateIp);
            console.log(`[containers] Route registered: ${body.subdomain} → ${info.privateIp}`);
            return;
          }
        }
        console.warn(`[containers] Route register timeout: no IP after 30s for ${body.subdomain}`);
      } catch (err) {
        console.error(`[containers] Route register failed for ${body.subdomain}:`, err);
      }
    })();

    return NextResponse.json({ success: true, data: { taskArn } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[containers] POST", message);
    const isDuplicate = message.includes("already has a running container");
    return NextResponse.json(
      { success: false, error: isDuplicate ? message : "Internal server error" },
      { status: isDuplicate ? 409 : 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const raw = await req.json();

    if (computeMode === "ec2") {
      const { subdomain, action: deleteAction } = raw as { subdomain: string; action?: string };
      if (deleteAction === "terminate") {
        await terminateInstance(subdomain);
      } else {
        await stopInstance(subdomain, "Stopped by admin");
      }
      return NextResponse.json({ success: true });
    }

    const parsed = stopContainerSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    const body = parsed.data;

    // Deregister route before stopping
    if (body.subdomain) {
      try {
        await deregisterContainerRoute(body.subdomain);
      } catch (err) {
        console.warn("[containers] Route deregister:", err);
      }
    }

    // EBS mode: get volume ID from task BEFORE stopping
    const serverStorageType = process.env.STORAGE_TYPE ?? "ebs";
    let ebsVolumeId: string | undefined;
    if (serverStorageType === "ebs" && body.taskArn) {
      try {
        const desc = await ecsExecClient.send(new DescribeTasksCommand({
          cluster: process.env.ECS_CLUSTER_NAME ?? "cc-on-bedrock-devenv",
          tasks: [body.taskArn],
        }));
        const ebsAttachment = desc.tasks?.[0]?.attachments?.find(a => a.type === "AmazonElasticBlockStorage");
        ebsVolumeId = ebsAttachment?.details?.find(d => d.name === "volumeId")?.value;
      } catch (err) {
        console.warn("[containers] Failed to get EBS volume ID:", err);
      }
    }

    await stopContainer(body);

    // EBS mode: trigger snapshot with volume ID
    if (serverStorageType === "ebs" && body.subdomain && ebsVolumeId) {
      try {
        const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
        const lambda = new LambdaClient({ region });
        await lambda.send(new InvokeCommand({
          FunctionName: process.env.EBS_LIFECYCLE_LAMBDA ?? "cc-on-bedrock-ebs-lifecycle",
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({
            action: "snapshot_and_detach",
            user_id: body.subdomain,
            volume_id: ebsVolumeId,
          })),
        }));
        console.log(`[containers] EBS snapshot triggered for ${body.subdomain} (vol: ${ebsVolumeId})`);
      } catch (err) {
        console.warn("[containers] EBS snapshot trigger failed:", err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[containers] DELETE", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
