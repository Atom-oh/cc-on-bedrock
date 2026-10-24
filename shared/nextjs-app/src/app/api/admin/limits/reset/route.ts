import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { releaseTokenDeny, TokenDenyDetachError } from "@/lib/token-deny";
import { requireFreshRole } from "@/lib/role-admin";

// ADR-031 (B′): admin force-reset for a single user's token-deny.
// Body: { email: string }  (canonical key; legacy alias `sub` accepted for old non-email rows)
//   → releaseTokenDeny: reads DENY#active (PK=USER#{email}), detaches cc-bedrock-local-token-deny
//     from the Local role named by the ROW's `subdomain` (NOT the email key), deletes DENY#active.

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  const fresh = await requireFreshRole(session, ["admin"]);
  if (!fresh.ok) return fresh.response;

  let body: { email?: string; sub?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  // ADR-031: canonical key is the lowercased email. `sub` is a legacy alias for old rows.
  const key = (body?.email ?? body?.sub)?.trim().toLowerCase();
  if (!key) return NextResponse.json({ error: "email is required" }, { status: 400 });

  let result;
  try {
    result = await releaseTokenDeny(key);
  } catch (e) {
    if (e instanceof TokenDenyDetachError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }

  if (!result.found) {
    return NextResponse.json({ ok: false, key, error: "no active token-deny for this user" }, { status: 404 });
  }
  // If the role can't be resolved (email-keyed row missing `subdomain`) the IAM deny cannot be
  // detached — DENY#active is preserved (clearing it would orphan the deny) + 207, same fail-safe
  // as the limit-reset cron.
  if (!result.released) {
    return NextResponse.json({
      ok: false,
      key,
      role: null,
      detached: false,
      denyCleared: false,
      warning: result.warning,
    }, { status: 207 });
  }

  return NextResponse.json({ ok: true, key, role: result.role, detached: result.detached, denyCleared: true });
}
