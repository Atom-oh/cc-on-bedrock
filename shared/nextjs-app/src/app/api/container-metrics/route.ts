import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getContainerMetrics,
  getContainerMetricsTimeSeries,
  getTaskDefMetrics,
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
      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
