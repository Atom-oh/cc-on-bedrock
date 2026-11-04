import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { createHash } from "crypto";
import {
  bearerToken,
  freshCallerChecks,
  isCognitoJwt,
  resolveCognitoAccessToken,
  type ResolvedCaller,
} from "@/lib/cli-auth";

// ADR-006 (legacy ADR-014): Local Governance Mode credentials API.
//
// Two auth paths converge here:
//   1. NextAuth session cookie (browser /local page) — preferred when human is at the keyboard.
//   2. `Authorization: Bearer ccb_...` (CLI script downloaded from /user page) — used by the
//      generated cc-bedrock-login.sh. Token is SHA-256 hashed and looked up in
//      cc-on-bedrock-cli-tokens; the row carries the verified user identity.
//
// Both paths produce the same identity object that gets handed to the STS Issuer Lambda.
// Every path then re-checks, fresh from Cognito, that the caller is still enabled and,
// in a shared user pool (COGNITO_GROUP_PREFIX set), holds a cc role group.

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const STS_ISSUER_FUNCTION = process.env.STS_ISSUER_FUNCTION_NAME ?? "cc-on-bedrock-sts-issuer";
const CLI_TOKENS_TABLE = process.env.CLI_TOKENS_TABLE ?? "cc-on-bedrock-cli-tokens";
// The Cognito access-token path (CLI public client only) lives in lib/cli-auth.ts.

const lambda = new LambdaClient({ region });
const ddb = new DynamoDBClient({ region });

async function resolveBearerToken(token: string): Promise<ResolvedCaller | null> {
  const hash = createHash("sha256").update(token).digest("hex");
  try {
    const r = await ddb.send(new GetItemCommand({
      TableName: CLI_TOKENS_TABLE,
      Key: { PK: { S: `HASH#${hash}` } },
    }));
    const item = r.Item;
    if (!item) return null;
    // Defense in depth: DynamoDB TTL is eventually consistent (can lag ~48h), so re-check.
    const expiresAt = Number(item.expiresAt?.N ?? "0");
    if (expiresAt && expiresAt < Math.floor(Date.now() / 1000)) return null;
    const sub = item.sub?.S ?? "";
    return {
      identity: {
        sub,
        username: item.username?.S ?? "",
        department: item.department?.S ?? "default",
        project: item.project?.S ?? "default",
      },
      // Cognito admin APIs accept the email alias; fall back to the sub.
      cognitoUsername: item.email?.S || sub || undefined,
    };
  } catch (e) {
    console.error("[cli-token] lookup failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function resolveIdentity(req: NextRequest): Promise<ResolvedCaller | null> {
  const token = bearerToken(req);
  if (token) {
    // Two Bearer flavors:
    //   1. ccb_<...>   — long-lived CLI token persisted in cc-on-bedrock-cli-tokens
    //   2. JWT (Cognito access token from CLI USER_PASSWORD_AUTH login)
    if (isCognitoJwt(token)) {
      return resolveCognitoAccessToken(token);
    }
    return resolveBearerToken(token);
  }
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const u = session.user;
  return {
    identity: {
      sub: u.id,
      username: u.subdomain ?? u.email ?? u.id,
      email: u.email ?? undefined,
      department: (u as { department?: string }).department ?? "default",
      project: "default",
    },
    cognitoUsername: u.email || undefined,
  };
}

export async function POST(req: NextRequest) {
  const caller = await resolveIdentity(req);
  if (!caller) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  // Fresh enabled / role-group checks and the shared-pool subdomain pin (lib/cli-auth).
  const checked = await freshCallerChecks(caller);
  if (!checked.ok) return checked.response;
  const { identity } = checked;

  try {
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: STS_ISSUER_FUNCTION,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(identity)),
    }));
    const text = resp.Payload ? Buffer.from(resp.Payload).toString("utf8") : "{}";
    const parsed = JSON.parse(text);
    let body: unknown = parsed;
    let status = 200;
    if (parsed && typeof parsed === "object" && "statusCode" in parsed) {
      status = Number((parsed as { statusCode: number }).statusCode) || 500;
      const bodyStr = (parsed as { body?: string }).body;
      body = bodyStr ? JSON.parse(bodyStr) : parsed;
    }
    return NextResponse.json(body, {
      status,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "STS issue failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
