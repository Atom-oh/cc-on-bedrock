import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getEc2Metrics } from "@/lib/cloudwatch-client";
import { listInstances } from "@/lib/ec2-clients";

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
    const instances = await listInstances();
    const userInstance = instances.find(
      (i) => i.subdomain === subdomain && i.status === "running"
    );

    if (!userInstance) {
      return NextResponse.json({
        success: true,
        data: null,
        message: "No running instance",
      });
    }

    const metrics = await getEc2Metrics(userInstance.instanceId);

    return NextResponse.json({
      success: true,
      data: metrics,
    });
  } catch (err) {
    console.error("[user/container-metrics] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
