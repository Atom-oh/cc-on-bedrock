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
} from "@/lib/aws-clients";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
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
      // Check if user already has a running container
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

      // Determine the tier to use: requested > user default > standard
      const tierToUse: ResourceTier = VALID_TIERS.includes(requestedTier)
        ? requestedTier
        : (user.resourceTier as ResourceTier) ?? "standard";

      // Validate tier against department policy
      const department = "default"; // Could be extended to read from user attributes
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

      // Auto-register route after a short delay for IP assignment
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

      await stopContainer({ taskArn, reason: "Stopped by user" });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[user/container] POST", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
