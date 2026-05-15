import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createHash } from "crypto";

// ADR-014: Local Governance Mode credentials API.
//
// Two auth paths converge here:
//   1. NextAuth session cookie (browser /local page) — preferred when human is at the keyboard.
//   2. `Authorization: Bearer ccb_...` (CLI script downloaded from /user page) — used by the
//      generated cc-bedrock-login.sh. Token is SHA-256 hashed and looked up in
//      cc-on-bedrock-cli-tokens; the row carries the verified user identity.
//
// Both paths produce the same identity object that gets handed to the STS Issuer Lambda.

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const STS_ISSUER_FUNCTION = process.env.STS_ISSUER_FUNCTION_NAME ?? "cc-on-bedrock-sts-issuer";
const CLI_TOKENS_TABLE = process.env.CLI_TOKENS_TABLE ?? "cc-on-bedrock-cli-tokens";
// ADR-014: only access tokens issued by the cc-bedrock-local CLI public client
// are accepted on the JWT Bearer path. Any other client in the same user pool
// (admin tools, future federated apps, misconfigured public clients) MUST NOT
// be able to call /api/local/credentials via Cognito access tokens.
const COGNITO_CLI_CLIENT_ID = process.env.COGNITO_CLI_CLIENT_ID ?? "";

const lambda = new LambdaClient({ region });
const ddb = new DynamoDBClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });

interface UserIdentity {
  sub: string;
  username: string;
  email?: string;
  department: string;
  project: string;
}

async function resolveBearerToken(token: string): Promise<UserIdentity | null> {
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
    return {
      sub: item.sub?.S ?? "",
      username: item.username?.S ?? "",
      department: item.department?.S ?? "default",
      project: item.project?.S ?? "default",
    };
  } catch (e) {
    console.error("[cli-token] lookup failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

// Decode (NOT verify) a Cognito JWT payload. Signature verification is delegated
// to cognito-idp:GetUser downstream — it rejects tokens that aren't signed by
// the user pool's keys. We pre-validate `client_id` and `token_use` so that
// access tokens from *other* clients in the same user pool don't pass through
// (GetUser would otherwise accept any valid pool token).
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveCognitoAccessToken(token: string): Promise<UserIdentity | null> {
  // H2 fix: pre-validate JWT claims before paying for a Cognito API call.
  // Access tokens carry `client_id` (not `aud`, which lives on ID tokens).
  const claims = decodeJwtPayload(token);
  if (!claims) {
    console.warn("[cognito-token] rejected: token is not a decodable JWT");
    return null;
  }
  if (claims.token_use !== "access") {
    console.warn(`[cognito-token] rejected: token_use=${String(claims.token_use)} (expected "access")`);
    return null;
  }
  if (!COGNITO_CLI_CLIENT_ID) {
    // Misconfiguration: refuse to fall back to "any client" semantics. Failing
    // closed here surfaces the missing env var instead of silently accepting
    // tokens from the dashboard app client (which uses NextAuth, not Bearer).
    console.error("[cognito-token] rejected: COGNITO_CLI_CLIENT_ID env var is empty");
    return null;
  }
  if (claims.client_id !== COGNITO_CLI_CLIENT_ID) {
    console.warn(`[cognito-token] rejected: client_id=${String(claims.client_id)} (expected CLI public client)`);
    return null;
  }

  try {
    const r = await cognito.send(new GetUserCommand({ AccessToken: token }));
    const attrs = Object.fromEntries(
      (r.UserAttributes ?? []).map((a) => [a.Name ?? "", a.Value ?? ""]),
    );
    const sub = attrs["sub"] || r.Username || "";
    if (!sub) return null;
    return {
      sub,
      username: attrs["custom:subdomain"] || attrs["email"] || r.Username || sub,
      email: attrs["email"] || undefined,
      department: attrs["custom:department"] || "default",
      project: "default",
    };
  } catch (e) {
    console.error("[cognito-token] GetUser failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function resolveIdentity(req: NextRequest): Promise<UserIdentity | null> {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) {
      // Two Bearer flavors:
      //   1. ccb_<...>   — long-lived CLI token persisted in cc-on-bedrock-cli-tokens
      //   2. JWT (Cognito access token from CLI USER_PASSWORD_AUTH login)
      // Cognito JWTs always start with "eyJ" (base64 of `{"a` JSON header).
      if (token.startsWith("eyJ")) {
        return resolveCognitoAccessToken(token);
      }
      return resolveBearerToken(token);
    }
  }
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const u = session.user;
  return {
    sub: u.id,
    username: u.subdomain ?? u.email ?? u.id,
    email: u.email ?? undefined,
    department: (u as { department?: string }).department ?? "default",
    project: "default",
  };
}

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

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
