import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  startContainerWithProgress,
  listContainers,
  registerContainerRoute,
  describeContainer,
} from "@/lib/aws-clients";
// Uses ProvisioningStepName as string via the callback pattern
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
const dynamodb = new DynamoDBClient({ region });
const domainName = process.env.NEXT_PUBLIC_DOMAIN_NAME ?? process.env.DOMAIN_NAME ?? "atomai.click";
const devSubdomain = process.env.NEXT_PUBLIC_DEV_SUBDOMAIN ?? process.env.DEV_SUBDOMAIN ?? "dev";

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
  } catch { /* default */ }
  return ["light", "standard", "power"];
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const user = session.user;
  if (!user.subdomain) {
    return new Response(JSON.stringify({ error: "No subdomain assigned" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { action?: string; resourceTier?: string; containerOs?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (body.action !== "start") {
    return new Response(JSON.stringify({ error: "Only 'start' action supported" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check for existing container
  try {
    const containers = await listContainers();
    const existing = containers.find(
      (c) =>
        c.subdomain === user.subdomain &&
        (c.status === "RUNNING" || c.status === "PENDING" || c.status === "PROVISIONING")
    );
    if (existing) {
      return new Response(JSON.stringify({ error: "You already have a running container" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: "Failed to check containers" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate tier
  const tierToUse: ResourceTier = VALID_TIERS.includes(body.resourceTier as ResourceTier)
    ? (body.resourceTier as ResourceTier)
    : (user.resourceTier as ResourceTier) ?? "standard";

  const department = "default";
  const allowedTiers = await getDeptAllowedTiers(department);
  if (!allowedTiers.includes(tierToUse)) {
    return new Response(
      JSON.stringify({ error: `Tier "${tierToUse}" is not allowed for your department` }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  const subdomain = user.subdomain;

  // SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (step: number, name: string, status: string, extra?: Record<string, string>) => {
        const data = JSON.stringify({ step, name, status, ...extra });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        const taskArn = await startContainerWithProgress(
          {
            username: user.email,
            subdomain,
            department,
            containerOs: (body.containerOs as "ubuntu" | "al2023") ?? user.containerOs ?? "ubuntu",
            resourceTier: tierToUse,
            securityPolicy: user.securityPolicy ?? "restricted",
            storageType: user.storageType ?? "efs",
          },
          (step, name, status, message) => {
            send(step, name, status, message ? { message } : undefined);
          }
        );

        // Step 6: Route registration
        send(6, "route_register", "in_progress", { message: "Waiting for IP assignment..." });

        let registered = false;
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const info = await describeContainer(taskArn);
            if (info?.privateIp) {
              await registerContainerRoute(subdomain, info.privateIp);
              registered = true;
              break;
            }
          } catch { /* retry */ }
          send(6, "route_register", "in_progress", { message: `Waiting for IP... (${i + 1}/8)` });
        }

        if (registered) {
          const url = `https://${subdomain}.${devSubdomain}.${domainName}`;
          send(6, "route_register", "completed", { message: "Route registered", url });
        } else {
          send(6, "route_register", "completed", { message: "Container started (route may take a moment)" });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        send(0, "iam_role", "failed", { error: msg });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
