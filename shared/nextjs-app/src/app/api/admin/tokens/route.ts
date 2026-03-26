import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getUsageRecords,
  getUserSummaries,
  getDepartmentSummaries,
} from "@/lib/usage-client";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const period = searchParams.get("period") ?? "7d";

  try {
    // Calculate date range based on period
    const now = new Date();
    const endDate = now.toISOString().split("T")[0];
    let startDate: string;

    switch (period) {
      case "1d":
        startDate = endDate;
        break;
      case "30d":
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0];
        break;
      case "7d":
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0];
    }

    // Fetch data in parallel
    const [records, userSummaries, deptSummaries] = await Promise.all([
      getUsageRecords({ startDate, endDate }),
      getUserSummaries({ startDate, endDate }),
      getDepartmentSummaries({ startDate, endDate }),
    ]);

    // Calculate totals
    const totalTokens = records.reduce((sum, r) => sum + r.totalTokens, 0);
    const totalCost = records.reduce((sum, r) => sum + r.estimatedCost, 0);
    const totalRequests = records.reduce((sum, r) => sum + r.requests, 0);

    // Top 10 users by token usage
    const topUsers = userSummaries.slice(0, 10).map((u) => ({
      userId: u.userId,
      department: u.department,
      totalTokens: u.totalTokens,
      totalCost: u.totalCost,
      requests: u.requests,
    }));

    // Department breakdown for chart
    const departmentBreakdown = deptSummaries.map((d) => ({
      name: d.department,
      tokens: d.totalTokens,
      cost: d.totalCost,
      requests: d.requests,
      userCount: d.userCount,
    }));

    return NextResponse.json({
      success: true,
      data: {
        period,
        startDate,
        endDate,
        totals: {
          tokens: totalTokens,
          cost: totalCost,
          requests: totalRequests,
          users: userSummaries.length,
          departments: deptSummaries.length,
        },
        topUsers,
        departmentBreakdown,
      },
    });
  } catch (err) {
    console.error("[admin/tokens] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
