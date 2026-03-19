import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getSpendLogs,
  getModelMetrics,
  getSpendPerDay,
  getTotalSpend,
  generateKey,
  listKeys,
  deleteKey,
  updateKey,
} from "@/lib/litellm-client";

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
        // Non-admin users can only see their own spend
        const effectiveUserId = session.user.isAdmin
          ? userId
          : session.user.id;
        const logs = await getSpendLogs({
          user_id: effectiveUserId,
          start_date: startDate,
          end_date: endDate,
        });
        return NextResponse.json({ success: true, data: logs });
      }

      case "model_metrics": {
        if (!session.user.isAdmin) {
          return NextResponse.json(
            { error: "Admin access required" },
            { status: 403 }
          );
        }
        const metrics = await getModelMetrics({
          start_date: startDate,
          end_date: endDate,
        });
        return NextResponse.json({ success: true, data: metrics });
      }

      case "spend_per_day": {
        const effectiveUserId = session.user.isAdmin
          ? userId
          : session.user.id;
        const spend = await getSpendPerDay({
          start_date: startDate,
          end_date: endDate,
          user_id: effectiveUserId,
        });
        return NextResponse.json({ success: true, data: spend });
      }

      case "total_spend": {
        if (!session.user.isAdmin) {
          return NextResponse.json(
            { error: "Admin access required" },
            { status: 403 }
          );
        }
        const total = await getTotalSpend();
        return NextResponse.json({ success: true, data: total });
      }

      case "list_keys": {
        if (!session.user.isAdmin) {
          return NextResponse.json(
            { error: "Admin access required" },
            { status: 403 }
          );
        }
        const keys = await listKeys();
        return NextResponse.json({ success: true, data: keys });
      }

      default:
        return NextResponse.json(
          { error: "Invalid action" },
          { status: 400 }
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { action, ...params } = body as { action: string; [key: string]: unknown };

  try {
    switch (action) {
      case "generate_key": {
        const key = await generateKey(
          params as Parameters<typeof generateKey>[0]
        );
        return NextResponse.json({ success: true, data: key });
      }

      case "delete_key": {
        await deleteKey(params.key as string);
        return NextResponse.json({ success: true });
      }

      case "update_key": {
        const updated = await updateKey(
          params as Parameters<typeof updateKey>[0]
        );
        return NextResponse.json({ success: true, data: updated });
      }

      default:
        return NextResponse.json(
          { error: "Invalid action" },
          { status: 400 }
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
