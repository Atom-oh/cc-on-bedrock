import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  startInstance,
  stopInstance,
  terminateInstance,
  listInstances,
} from "@/lib/ec2-clients";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const instanceId = searchParams.get("taskArn") ?? searchParams.get("instanceId");

  try {
    const instances = await listInstances();
    const mapped = instances.map(i => ({
      taskArn: i.instanceId,
      taskId: i.instanceId,
      status: i.status.toUpperCase(),
      desiredStatus: i.status.toUpperCase(),
      username: i.username,
      subdomain: i.subdomain,
      containerOs: "ubuntu" as const,
      resourceTier: i.instanceType ?? "standard",
      securityPolicy: i.securityPolicy,
      privateIp: i.privateIp,
      healthStatus: i.status === "running" ? "HEALTHY" : "UNKNOWN",
    }));

    if (instanceId) {
      const found = mapped.find(m => m.taskArn === instanceId);
      return NextResponse.json({ success: true, data: found ?? null });
    }
    return NextResponse.json({ success: true, data: mapped });
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
    const { subdomain, username, department, securityPolicy, resourceTier } = raw as {
      subdomain: string; username: string; department?: string;
      securityPolicy?: string; resourceTier?: string;
    };
    const result = await startInstance({
      subdomain,
      username,
      department: department ?? "default",
      securityPolicy: (securityPolicy ?? "restricted") as "open" | "restricted" | "locked",
      resourceTier: resourceTier as "light" | "standard" | "power" | undefined,
    });
    return NextResponse.json({ success: true, data: { taskArn: result.instanceId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[containers] POST", message);
    const isDuplicate = message.includes("already has");
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
    const { subdomain, action: deleteAction } = raw as { subdomain: string; action?: string };
    if (deleteAction === "terminate") {
      await terminateInstance(subdomain);
    } else {
      await stopInstance(subdomain, "Stopped by admin");
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[containers] DELETE", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
