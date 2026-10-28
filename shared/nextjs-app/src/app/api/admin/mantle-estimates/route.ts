import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getMantleRows, summarizeMantle, MANTLE_ESTIMATE_CAVEAT } from "@/lib/mantle-estimate";

// ADR-014 §9 stage 1: estimated (not metered) Codex-on-mantle cost per user, month to date.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  const period = new URL(req.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
  }
  try {
    const { rows, truncated } = await getMantleRows({ period });
    return NextResponse.json({
      success: true,
      data: { period, users: summarizeMantle(rows, period), truncated, caveat: MANTLE_ESTIMATE_CAVEAT },
    });
  } catch (err) {
    console.error("[admin/mantle-estimates] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
