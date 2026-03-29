import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getTaskMetrics } from "@/lib/cloudwatch-client";
import { listContainers } from "@/lib/aws-clients";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const subdomain = session.user.subdomain;
  if (!subdomain) {
    return NextResponse.json({ error: "No subdomain assigned" }, { status: 400 });
  }

  try {
    // Find the user's running container
    const containers = await listContainers();
    const userContainer = containers.find(
      (c) => c.subdomain === subdomain && c.status === "RUNNING"
    );

    if (!userContainer) {
      return NextResponse.json({
        success: true,
        data: null,
        message: "No running container",
      });
    }

    const metrics = await getTaskMetrics(userContainer.taskId);

    return NextResponse.json({
      success: true,
      data: metrics,
    });
  } catch (err) {
    console.error("[user/container-metrics] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
