import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCognitoUser } from "@/lib/aws-clients";
import {
  startInstance,
  stopInstance,
  listInstances,
} from "@/lib/ec2-clients";
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

  if (action === "verify") {
    try {
      const cognitoUser = await getCognitoUser(user.email);
      return NextResponse.json({
        success: true,
        data: { subdomain: cognitoUser.subdomain || null },
      });
    } catch {
      return NextResponse.json({ success: true, data: { subdomain: null } });
    }
  }

  if (!user.subdomain) {
    return NextResponse.json({ success: true, data: null });
  }

  try {
    const instances = await listInstances();
    const userInstance = instances.find(
      (i) => i.subdomain === user.subdomain && (i.status === "running" || i.status === "pending")
    );
    if (userInstance) {
      return NextResponse.json({ success: true, data: {
        taskArn: userInstance.instanceId,
        taskId: userInstance.instanceId,
        status: userInstance.status.toUpperCase(),
        desiredStatus: userInstance.status.toUpperCase(),
        username: userInstance.username,
        subdomain: userInstance.subdomain,
        containerOs: "ubuntu",
        resourceTier: userInstance.instanceType ?? "standard",
        securityPolicy: userInstance.securityPolicy,
        privateIp: userInstance.privateIp,
        healthStatus: userInstance.status === "running" ? "HEALTHY" : "UNKNOWN",
      }});
    }
    return NextResponse.json({ success: true, data: null });
  } catch (err) {
    console.error("[user/container GET]", err);
    return NextResponse.json({ error: "Failed to fetch instance" }, { status: 500 });
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
    const { action, resourceTier: requestedTier } = body;

    if (action === "start") {
      const tierToUse: ResourceTier = VALID_TIERS.includes(requestedTier)
        ? requestedTier
        : (user.resourceTier as ResourceTier) ?? "standard";

      const department = ((user as unknown as Record<string, string>).department) ?? "default";
      const allowedTiers = await getDeptAllowedTiers(department);

      if (!allowedTiers.includes(tierToUse)) {
        return NextResponse.json(
          { success: false, error: `Tier "${tierToUse}" is not allowed for your department. Allowed: ${allowedTiers.join(", ")}` },
          { status: 403 }
        );
      }

      const result = await startInstance({
        subdomain: user.subdomain,
        username: user.email,
        department,
        securityPolicy: (user.securityPolicy ?? "restricted") as "open" | "restricted" | "locked",
        resourceTier: tierToUse,
      });
      return NextResponse.json({ success: true, data: { taskArn: result.instanceId } });
    }

    if (action === "stop") {
      await stopInstance(user.subdomain, "Stopped by user");
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[user/container] POST", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
