import { NextRequest, NextResponse } from "next/server";
import { authenticateCliAccessToken } from "@/lib/cli-auth";
import { validateSessionReport } from "@/lib/session-report";
import { sessionInsightsEnabled } from "@/lib/session-usage";
import { invokeLambdaJson } from "@/lib/lambda-invoke";

// Session report ingest for the cc-bedrock-local CLI (session insights).
// Bearer only: a Cognito access token of the CLI public client (lib/cli-auth), the same
// checks as the Bearer JWT path of /api/local/credentials. Session cookies and `ccb_`
// tokens are refused. The data is client-reported and used for insight only; budgets
// and metering keep using Bedrock invocation logs (ADR-005).
// /api/local/* is outside the middleware matcher, so no session cookie is required.

const USAGE_TRACKER_FUNCTION = process.env.USAGE_TRACKER_FUNCTION_NAME ?? "cc-on-bedrock-usage-tracker";
const MAX_BODY_BYTES = 512 * 1024;

export async function POST(req: NextRequest) {
  const auth = await authenticateCliAccessToken(req);
  if (!auth.ok) return auth.response;
  const { identity, cognitoSubdomain } = auth.caller;
  const email = identity.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Account has no email" }, { status: 403 });
  }

  // Feature off (Terraform enable_session_insights = false → SESSIONS_TABLE ""): answer
  // 200 so the CLI marks its buckets sent instead of retrying forever.
  if (!sessionInsightsEnabled()) {
    return NextResponse.json(
      { accepted: 0, rejected: 0, disabled: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const report = validateSessionReport(body);
  if (!report.ok) return NextResponse.json({ error: report.error }, { status: 400 });

  try {
    const result = await invokeLambdaJson(USAGE_TRACKER_FUNCTION, {
      source: "cc.session-report",
      email,
      department: identity.department,
      // Shared pool: the fresh pin; own pool: custom:subdomain from GetUser.
      subdomain: identity.subdomain ?? cognitoSubdomain ?? "",
      buckets: report.buckets,
    });
    if (!result.ok) {
      console.error("[local/sessions] tracker error:", result.error);
      return NextResponse.json({ error: "Session report failed" }, { status: 502 });
    }
    const out = (result.body ?? {}) as { accepted?: unknown; rejected?: unknown; error?: unknown };
    if (typeof out.accepted !== "number") {
      console.error("[local/sessions] unexpected tracker response");
      return NextResponse.json({ error: "Session report failed" }, { status: 502 });
    }
    // Tracker re-validates: `rejected` counts dropped buckets; a request-level problem is
    // `accepted: 0` plus `error`. Both are passed through (200; resending would not help).
    if (typeof out.error === "string") console.warn("[local/sessions] tracker refused:", out.error);
    return NextResponse.json(
      {
        accepted: out.accepted,
        rejected: typeof out.rejected === "number" ? out.rejected : 0,
        ...(typeof out.error === "string" ? { error: out.error.slice(0, 200) } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[local/sessions] invoke failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Session report failed" }, { status: 502 });
  }
}
