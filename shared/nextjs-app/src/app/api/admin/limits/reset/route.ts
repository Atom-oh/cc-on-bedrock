import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  IAMClient,
  DeleteRolePolicyCommand,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";

// ADR-014: admin force-reset for a single user's token-deny.
// Body: { sub: string }   → detaches cc-bedrock-local-token-deny + deletes DENY#active

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const LIMITS_TABLE = process.env.LIMITS_TABLE ?? "cc-on-bedrock-limits";
const ROLE_PREFIX = "cc-on-bedrock-local-user-";
const POLICY_NAME = "cc-bedrock-local-token-deny";

const dynamo = new DynamoDBClient({ region });
const iam = new IAMClient({ region });

function safeSuffix(sub: string): string {
  return sub.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  let body: { sub?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const sub = body?.sub?.trim();
  if (!sub) return NextResponse.json({ error: "sub is required" }, { status: 400 });

  const roleName = `${ROLE_PREFIX}${safeSuffix(sub)}`;
  let detached = false;
  try {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: POLICY_NAME }));
    detached = true;
  } catch (e) {
    if (!(e instanceof NoSuchEntityException)) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `detach failed: ${msg}` }, { status: 500 });
    }
  }

  await dynamo.send(new DeleteItemCommand({
    TableName: LIMITS_TABLE,
    Key: marshall({ PK: `USER#${sub}`, SK: "DENY#active" }),
  }));

  return NextResponse.json({ ok: true, sub, role: roleName, detached });
}
