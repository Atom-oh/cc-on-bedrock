import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  GetItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  IAMClient,
  DeleteRolePolicyCommand,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";

// ADR-031 (B′): admin force-reset for a single user's token-deny.
// Body: { email: string }  (canonical key; legacy alias `sub` accepted for old non-email rows)
//   → reads DENY#active (PK=USER#{email}), detaches cc-bedrock-local-token-deny from the
//     Local role named by the ROW's `subdomain` (NOT the email key), deletes DENY#active.
// The key is the email; the Local role is cc-on-bedrock-local-user-{subdomain}, so the two are
// distinct and must be resolved separately — using the key as the role suffix would no-op.

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const LIMITS_TABLE = process.env.LIMITS_TABLE ?? "cc-on-bedrock-limits";
const ROLE_PREFIX = "cc-on-bedrock-local-user-";
const POLICY_NAME = "cc-bedrock-local-token-deny";

const dynamo = new DynamoDBClient({ region });
const iam = new IAMClient({ region });

function safeSuffix(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
}

// Mirror limit-reset.py._role_for_item (ADR-031): prefer the row's `subdomain` attr;
// fall back to a non-email PK suffix for legacy rows; an email-keyed row with no
// subdomain attr cannot safely build a role name (returns null).
function roleForRow(key: string, subdomain: string): string | null {
  if (subdomain) return `${ROLE_PREFIX}${subdomain}`;
  if (key && !key.includes("@")) return `${ROLE_PREFIX}${safeSuffix(key)}`; // legacy sub/subdomain key
  return null;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  let body: { email?: string; sub?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  // ADR-031: canonical key is the lowercased email. `sub` is a legacy alias for old rows.
  const key = (body?.email ?? body?.sub)?.trim().toLowerCase();
  if (!key) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const pk = `USER#${key}`;

  // Read the DENY#active row first — we need its `subdomain` to find the Local role.
  const got = await dynamo.send(new GetItemCommand({
    TableName: LIMITS_TABLE,
    Key: marshall({ PK: pk, SK: "DENY#active" }),
  }));
  if (!got.Item) {
    return NextResponse.json({ ok: false, key, error: "no active token-deny for this user" }, { status: 404 });
  }
  const item = unmarshall(got.Item);
  const subdomain = (item.subdomain ?? "").toString().trim();
  const roleName = roleForRow(key, subdomain);

  let detached = false;
  if (roleName) {
    try {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: POLICY_NAME }));
      detached = true;
    } catch (e) {
      if (!(e instanceof NoSuchEntityException)) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: `detach failed for ${roleName}: ${msg}` }, { status: 500 });
      }
      // NoSuchEntity: role or policy already gone — treat as already-detached.
    }
  }

  // Clear the DENY#active row so the enforcer/limit-reset see the user as un-blocked.
  await dynamo.send(new DeleteItemCommand({
    TableName: LIMITS_TABLE,
    Key: marshall({ PK: pk, SK: "DENY#active" }),
  }));

  // If the role couldn't be resolved (email-keyed row missing subdomain), the IAM deny policy
  // may still be attached — surface that instead of falsely reporting full success.
  if (!roleName) {
    return NextResponse.json({
      ok: false,
      key,
      role: null,
      detached: false,
      denyCleared: true,
      warning: "DENY#active cleared but role name unresolved (row missing `subdomain`); verify IAM deny policy is detached manually",
    }, { status: 207 });
  }

  return NextResponse.json({ ok: true, key, role: roleName, detached, denyCleared: true });
}
