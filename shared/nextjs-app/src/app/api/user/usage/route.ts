import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUsageRecords } from "@/lib/usage-client";

const DEFAULT_DAILY_LIMIT = 100000; // Default daily token limit

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? new Date().toISOString().split("T")[0];

  try {
    // Get usage records for the current user and date
    const records = await getUsageRecords({
      userId: session.user.email,
      startDate: date,
      endDate: date,
    });

    // Aggregate usage for the day
    const totalTokens = records.reduce((sum, r) => sum + r.totalTokens, 0);
    const requests = records.reduce((sum, r) => sum + r.requests, 0);
    const estimatedCost = records.reduce((sum, r) => sum + r.estimatedCost, 0);

    // Daily limit could be stored in user attributes or a config table
    // For now, use a default value
    const dailyLimit = DEFAULT_DAILY_LIMIT;

    return NextResponse.json({
      success: true,
      data: {
        totalTokens,
        dailyLimit,
        requests,
        estimatedCost,
        date,
      },
    });
  } catch (err) {
    console.error("[user/usage] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
