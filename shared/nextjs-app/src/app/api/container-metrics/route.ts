import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getContainerMetrics,
  getContainerMetricsTimeSeries,
  getTaskDefMetrics,
  getBedrockMetrics,
  getBedrockMetricsTimeSeries,
} from "@/lib/cloudwatch-client";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") ?? "current";

  try {
    switch (action) {
      case "current": {
        const metrics = await getContainerMetrics();
        return NextResponse.json({ success: true, data: metrics });
      }
      case "timeseries": {
        const hours = parseInt(searchParams.get("hours") ?? "6", 10);
        const ts = await getContainerMetricsTimeSeries(hours);
        return NextResponse.json({ success: true, data: ts });
      }
      case "taskdef": {
        const taskDefs = await getTaskDefMetrics();
        return NextResponse.json({ success: true, data: taskDefs });
      }
      case "bedrock": {
        const brMetrics = await getBedrockMetrics();
        return NextResponse.json({ success: true, data: brMetrics });
      }
      case "bedrock_timeseries": {
        const brHours = parseInt(searchParams.get("hours") ?? "6", 10);
        const brTs = await getBedrockMetricsTimeSeries(brHours);
        return NextResponse.json({ success: true, data: brTs });
      }
      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    console.error("[container-metrics]", action, err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
