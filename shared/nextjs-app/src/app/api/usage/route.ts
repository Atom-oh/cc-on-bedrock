/**
 * Usage Analytics API Route
 * Data source: DynamoDB (cc-on-bedrock-usage) populated by Bedrock Invocation Logging
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getUsageRecords,
  getUserSummaries,
  getDepartmentSummaries,
  getModelSummaries,
  getDailyUsage,
  getTotalUsage,
} from "@/lib/usage-client";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const startDate = searchParams.get("start_date") ?? undefined;
  const endDate = searchParams.get("end_date") ?? undefined;
  const userId = searchParams.get("user_id") ?? undefined;

  try {
    switch (action) {
      case "spend_logs": {
        // SpendLog-compatible format for analytics dashboard
        const effectiveUserId = session.user.isAdmin ? userId : session.user.id;
        const records = await getUsageRecords({
          startDate,
          endDate,
          userId: effectiveUserId,
        });
        // Map to SpendLog-compatible format
        const data = records.map((r) => ({
          request_id: `${r.userId}-${r.date}-${r.model}`,
          api_key: r.userId,
          model: r.model,
          call_type: "chat",
          spend: r.estimatedCost,
          total_tokens: r.totalTokens,
          prompt_tokens: r.inputTokens,
          completion_tokens: r.outputTokens,
          startTime: `${r.date}T00:00:00Z`,
          endTime: `${r.date}T23:59:59Z`,
          user: r.userId,
          department: r.department,
          status: "success",
        }));
        return NextResponse.json({ success: true, data });
      }

      case "model_metrics": {
        if (!session.user.isAdmin) {
          return NextResponse.json({ error: "Admin access required" }, { status: 403 });
        }
        const models = await getModelSummaries({ startDate, endDate });
        const data = models.map((m) => ({
          model: m.model,
          num_requests: m.requests,
          total_tokens: m.totalTokens,
          avg_latency_seconds: m.avgLatencyMs / 1000,
          total_spend: m.totalCost,
        }));
        return NextResponse.json({ success: true, data });
      }

      case "spend_per_day": {
        const effectiveUserId = session.user.isAdmin ? userId : session.user.id;
        const daily = await getDailyUsage({ startDate, endDate, userId: effectiveUserId });
        return NextResponse.json({ success: true, data: daily });
      }

      case "total_spend": {
        if (!session.user.isAdmin) {
          return NextResponse.json({ error: "Admin access required" }, { status: 403 });
        }
        const total = await getTotalUsage();
        return NextResponse.json({ success: true, data: total });
      }

      case "user_summaries": {
        if (!session.user.isAdmin) {
          return NextResponse.json({ error: "Admin access required" }, { status: 403 });
        }
        const users = await getUserSummaries({ startDate, endDate });
        return NextResponse.json({ success: true, data: users });
      }

      case "department_summaries": {
        if (!session.user.isAdmin) {
          return NextResponse.json({ error: "Admin access required" }, { status: 403 });
        }
        const depts = await getDepartmentSummaries({ startDate, endDate });
        return NextResponse.json({ success: true, data: depts });
      }

      case "system_health": {
        if (!session.user.isAdmin) {
          return NextResponse.json({ error: "Admin access required" }, { status: 403 });
        }
        // Direct Bedrock mode - no proxy health to check
        return NextResponse.json({
          success: true,
          data: {
            status: "healthy",
            db: "dynamodb",
            cache: "none",
            version: "bedrock-direct",
            model_count: 0,
            architecture: "Direct Bedrock",
          },
        });
      }

      // Legacy compatibility: key_spend_list returns empty (no API keys in direct mode)
      case "key_spend_list":
      case "list_keys":
        return NextResponse.json({ success: true, data: [] });

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    console.error("[usage] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

