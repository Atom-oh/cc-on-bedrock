import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireFreshRole } from "@/lib/role-admin";
import { invokeLambdaAsync } from "@/lib/lambda-invoke";
import { getSessionInsights, sessionInsightsEnabled } from "@/lib/session-usage";

// Session insights for the admin Overview (client-reported sessions + daily Haiku
// analysis). GET: admin session (middleware also gates /api/admin); `insightDate` returns
// that date's insight instead of the latest. POST re-checks the role fresh from Cognito and
// queues a regenerate (async Event invoke, 202); the panel polls GET until the row's
// generatedAt is after requestedAt. Async because the Lambda (up to 120 s) can outlast
// the CloudFront origin read timeout.

// Unset (local dev) = default; "" (Terraform enable_session_insights = false) = feature off.
const SESSION_INSIGHTS_FUNCTION =
  process.env.SESSION_INSIGHTS_FUNCTION_NAME ?? "cc-on-bedrock-session-insights";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  if (!sessionInsightsEnabled()) {
    return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const raw = new URL(req.url).searchParams.get("days");
  const days = raw === null ? 7 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    return NextResponse.json({ error: "days must be an integer 1-31" }, { status: 400 });
  }
  const insightDate = new URL(req.url).searchParams.get("insightDate") ?? undefined;
  if (insightDate !== undefined && !DATE_RE.test(insightDate)) {
    return NextResponse.json({ error: "insightDate must be YYYY-MM-DD" }, { status: 400 });
  }
  try {
    const data = await getSessionInsights(days, new Date(), insightDate);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[session-insights] read failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Failed to load session insights" }, { status: 500 });
  }
}

/** Yesterday (UTC): the date the scheduled run analyzes. */
function defaultDate(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const fresh = await requireFreshRole(session, ["admin"]);
  if (!fresh.ok) return fresh.response;
  if (!sessionInsightsEnabled() || SESSION_INSIGHTS_FUNCTION.trim() === "") {
    return NextResponse.json({ error: "session_insights_disabled" }, { status: 503 });
  }

  let body: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
    }
  }
  const rawDate = body && typeof body === "object" ? (body as { date?: unknown }).date : undefined;
  let date = defaultDate();
  if (rawDate !== undefined && rawDate !== null) {
    if (
      typeof rawDate !== "string" ||
      !DATE_RE.test(rawDate) ||
      Number.isNaN(Date.parse(`${rawDate}T00:00:00Z`)) ||
      new Date(`${rawDate}T00:00:00Z`).toISOString().slice(0, 10) !== rawDate ||
      rawDate > new Date().toISOString().slice(0, 10)
    ) {
      return NextResponse.json({ error: "date must be a past YYYY-MM-DD" }, { status: 400 });
    }
    date = rawDate;
  }

  try {
    const requestedAt = new Date().toISOString();
    await invokeLambdaAsync(SESSION_INSIGHTS_FUNCTION, { date, force: true });
    return NextResponse.json(
      { date, requestedAt },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[session-insights] regenerate failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Insight generation could not be started" }, { status: 502 });
  }
}
