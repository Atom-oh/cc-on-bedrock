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
  getUserDailyTrend,
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
        // DynamoDB PK is USER#{subdomain}, not Cognito sub UUID
        const effectiveUserId = session.user.isAdmin ? userId : session.user.subdomain;
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
        const effectiveUserId = session.user.isAdmin ? userId : session.user.subdomain;
        const daily = await getDailyUsage({ startDate, endDate, userId: effectiveUserId });
        return NextResponse.json({ success: true, data: daily });
      }

      case "total_spend": {
        if (!session.user.isAdmin) {
          return NextResponse.json({ error: "Admin access required" }, { status: 403 });
        }
        const total = await getTotalUsage({ startDate, endDate });
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

      case "user_daily_trend": {
        // Date-range validation (bound the scan window up front).
        if (!startDate || !endDate) {
          return NextResponse.json({ error: "start_date and end_date are required" }, { status: 400 });
        }
        if (startDate > endDate) {
          return NextResponse.json({ error: "start_date must be <= end_date" }, { status: 400 });
        }
        const today = new Date().toISOString().slice(0, 10);
        if (startDate > today || endDate > today) {
          return NextResponse.json({ error: "date range cannot be in the future" }, { status: 400 });
        }
        const spanDays = Math.round(
          (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000,
        );
        if (spanDays > 92) {
          return NextResponse.json({ error: "date range too large (max 92 days)" }, { status: 400 });
        }

        // Fail-CLOSED RBAC scope from the session (never from client params).
        const rawTopN = Number(searchParams.get("top_n"));
        const topN = Number.isFinite(rawTopN) && rawTopN > 0 ? Math.min(Math.trunc(rawTopN), 15) : 8;
        let scope: { department?: string; userId?: string };
        if (session.user.isAdmin) {
          scope = {};
        } else if (session.user.isDeptManager) {
          if (!session.user.department) {
            return NextResponse.json({ error: "no department on account" }, { status: 403 });
          }
          scope = { department: session.user.department };
        } else {
          if (!session.user.subdomain) {
            return NextResponse.json({ error: "no subdomain on account" }, { status: 403 });
          }
          scope = { userId: session.user.subdomain };
        }

        const trend = await getUserDailyTrend({ startDate, endDate, topN, ...scope });
        return NextResponse.json({ success: true, data: trend });
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

