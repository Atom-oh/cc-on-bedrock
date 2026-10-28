import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getMantleRows, summarizeMantle, MANTLE_ESTIMATE_CAVEAT } from "@/lib/mantle-estimate";

// ADR-014 §9 stage 1: the caller's own estimated (not metered) mantle cost, month to date.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const email = (session.user.email ?? "").trim().toLowerCase();
  const period = new Date().toISOString().slice(0, 7);
  try {
    const { rows, truncated } = email ? await getMantleRows({ email, period }) : { rows: [], truncated: false };
    const [me] = summarizeMantle(rows, period);
    return NextResponse.json({
      success: true,
      data: { period, estimate: me ?? null, truncated, caveat: MANTLE_ESTIMATE_CAVEAT },
    });
  } catch (err) {
    console.error("[user/mantle-estimate] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
