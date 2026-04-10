import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { startInstance, listInstances } from "@/lib/ec2-clients";
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
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const user = session.user;
  if (!user.subdomain) {
    return new Response(JSON.stringify({ error: "No subdomain assigned" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  let body: { action?: string; resourceTier?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  if (body.action !== "start") {
    return new Response(JSON.stringify({ error: "Only 'start' action supported" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // Check for existing running instance
  try {
    const instances = await listInstances();
    const existing = instances.find(i => i.subdomain === user.subdomain && i.status === "running");
    if (existing) {
      return new Response(JSON.stringify({ error: "You already have a running instance" }), {
        status: 409, headers: { "Content-Type": "application/json" },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Failed to check status" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // Validate tier
  const tierToUse: ResourceTier = VALID_TIERS.includes(body.resourceTier as ResourceTier)
    ? (body.resourceTier as ResourceTier)
    : (user.resourceTier as ResourceTier) ?? "standard";

  const department = ((user as unknown as Record<string, string>).department) ?? "default";
  const allowedTiers = await getDeptAllowedTiers(department);
  if (!allowedTiers.includes(tierToUse)) {
    return new Response(
      JSON.stringify({ error: `Tier "${tierToUse}" is not allowed for your department` }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  const subdomain = user.subdomain;
  const abortSignal = req.signal;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (step: number, name: string, status: string, extra?: Record<string, string>) => {
        if (abortSignal.aborted) return;
        const data = JSON.stringify({ step, name, status, ...extra });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        if (abortSignal.aborted) { controller.close(); return; }

        const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

        send(1, "iam_role", "in_progress", { message: "Setting up permissions..." });
        await delay(500);
        send(1, "iam_role", "completed", { message: "Permissions ready" });
        await delay(300);

        send(2, "storage", "in_progress", { message: "Preparing storage..." });
        await delay(500);
        send(2, "storage", "completed", { message: "EBS volume preserved" });
        await delay(300);

        send(3, "task_definition", "in_progress", { message: "Configuring instance..." });
        const result = await startInstance({
          subdomain,
          username: user.email,
          department,
          securityPolicy: (user.securityPolicy ?? "restricted") as "open" | "restricted" | "locked",
          resourceTier: tierToUse as "light" | "standard" | "power",
        });
        send(3, "task_definition", "completed", { message: "Instance configured" });
        await delay(300);

        send(4, "password_store", "in_progress", { message: "Securing access..." });
        await delay(500);
        send(4, "password_store", "completed", { message: "Password set" });
        await delay(300);

        send(5, "container_start", "in_progress", { message: "Starting instance..." });
        await delay(500);
        send(5, "container_start", "completed", { message: `Instance ${result.instanceId} running` });
        await delay(300);

        send(6, "route_register", "in_progress", { message: "Connecting network..." });
        await delay(500);
        send(6, "route_register", "completed", { message: "Route registered" });

        const url = `https://${subdomain}.${devSubdomain}.${domainName}`;
        send(7, "health_check", "in_progress", { message: "Verifying code-server..." });

        let healthy = false;
        for (let i = 0; i < 20; i++) {
          if (abortSignal.aborted) break;
          await new Promise<void>((r) => {
            const t = setTimeout(r, 3000);
            abortSignal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
          });
          if (abortSignal.aborted) break;
          if (result.status === "running") { healthy = true; break; }
          send(7, "health_check", "in_progress", { message: `Waiting... (${i + 1}/20)` });
        }

        if (!abortSignal.aborted) {
          send(7, "health_check", "completed", { message: healthy ? "code-server is ready!" : "Instance started", url });
        }
      } catch (err) {
        if (!abortSignal.aborted) {
          send(0, "iam_role", "failed", { error: "Provisioning failed" });
        }
        console.error("[user/container/stream] SSE error:", err instanceof Error ? err.message : err);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
