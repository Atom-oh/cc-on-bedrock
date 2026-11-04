// Cognito access-token authentication for the cc-bedrock-local CLI (ADR-006).
//
// Shared by /api/local/credentials (Bearer JWT path) and /api/local/sessions. Only access
// tokens issued by the CLI public client (COGNITO_CLI_CLIENT_ID) are accepted; any other
// client in the same user pool is refused before Cognito is called. Signature verification
// is delegated to cognito-idp:GetUser, which rejects tokens not signed by the pool.
import { NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { pinnedIdentity, requireAnyRoleGroup } from "./role-admin";
import { requiresRoleGroup } from "./roles";
import { userPoolId } from "./aws-clients";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const cognito = new CognitoIdentityProviderClient({ region });

type Send = (command: unknown) => Promise<unknown>;
const defaultSend: Send = (command) =>
  (cognito.send as (c: unknown) => Promise<unknown>)(command);

export interface UserIdentity {
  sub: string;
  username: string;
  email?: string;
  department: string;
  project: string;
  /** Shared pool only: the pinned `custom:subdomain` that names the Local role. */
  subdomain?: string;
  /** Shared pool only: scopes the role's `sub` binding (`sub:<pool>` tag). */
  pool?: string;
}

/** Identity for the STS Issuer plus the Cognito username used for the fresh role-group check. */
export interface ResolvedCaller {
  identity: UserIdentity;
  cognitoUsername?: string;
  /**
   * `custom:subdomain` as returned by GetUser (Cognito access-token path only). Kept off
   * `identity` so the STS Issuer payload is unchanged; `identity.subdomain` is only the
   * shared-pool pin.
   */
  cognitoSubdomain?: string;
}

/** The Bearer token of the request, or null when there is none. */
export function bearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!authHeader?.toLowerCase().startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

/** Cognito JWTs always start with "eyJ" (base64 of a `{"a` JSON header). */
export function isCognitoJwt(token: string): boolean {
  return token.startsWith("eyJ");
}

// Decode (NOT verify) a Cognito JWT payload. Signature verification is delegated
// to cognito-idp:GetUser downstream — it rejects tokens that aren't signed by
// the user pool's keys. We pre-validate `client_id` and `token_use` so that
// access tokens from *other* clients in the same user pool don't pass through
// (GetUser would otherwise accept any valid pool token).
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
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

export async function resolveCognitoAccessToken(
  token: string,
  send: Send = defaultSend,
  // Read per call (not at module load) so tests can vary it; same value in a deployment.
  cliClientId: string = process.env.COGNITO_CLI_CLIENT_ID ?? ""
): Promise<ResolvedCaller | null> {
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
  if (!cliClientId) {
    // Misconfiguration: refuse to fall back to "any client" semantics. Failing
    // closed here surfaces the missing env var instead of silently accepting
    // tokens from the dashboard app client (which uses NextAuth, not Bearer).
    console.error("[cognito-token] rejected: COGNITO_CLI_CLIENT_ID env var is empty");
    return null;
  }
  if (claims.client_id !== cliClientId) {
    console.warn(`[cognito-token] rejected: client_id=${String(claims.client_id)} (expected CLI public client)`);
    return null;
  }

  try {
    const r = (await send(new GetUserCommand({ AccessToken: token }))) as {
      Username?: string;
      UserAttributes?: { Name?: string; Value?: string }[];
    };
    const attrs = Object.fromEntries(
      (r.UserAttributes ?? []).map((a) => [a.Name ?? "", a.Value ?? ""]),
    );
    const sub = attrs["sub"] || r.Username || "";
    if (!sub) return null;
    return {
      identity: {
        sub,
        username: attrs["custom:subdomain"] || attrs["email"] || r.Username || sub,
        email: attrs["email"] || undefined,
        department: attrs["custom:department"] || "default",
        project: "default",
      },
      // The token is verified by GetUser; groups are read fresh, never from its claims.
      cognitoUsername: r.Username || attrs["email"] || undefined,
      cognitoSubdomain: attrs["custom:subdomain"] || undefined,
    };
  } catch (e) {
    console.error("[cognito-token] GetUser failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export type CallerCheck =
  | { ok: true; identity: UserIdentity }
  | { ok: false; response: NextResponse };

/**
 * Fresh Cognito checks every CLI-facing path applies after authentication: the user is
 * still enabled and, in a shared pool (COGNITO_GROUP_PREFIX set), holds a cc role group
 * (403; lookup failure 503). Shared pool (ADR-016) also pins the identity to the fresh
 * `custom:subdomain`/email of the caller's own record (sub mismatch 403, failure 503).
 * Mutates and returns `caller.identity`.
 */
export async function freshCallerChecks(
  caller: ResolvedCaller,
  deps: {
    anyRoleGroup?: typeof requireAnyRoleGroup;
    pin?: typeof pinnedIdentity;
    shared?: () => boolean;
  } = {}
): Promise<CallerCheck> {
  const { identity } = caller;
  const anyRoleGroup = deps.anyRoleGroup ?? requireAnyRoleGroup;
  const pin = deps.pin ?? pinnedIdentity;
  const shared = deps.shared ?? (() => requiresRoleGroup());
  // Disabled user, or no cc role group in a shared pool → 403; lookup failure → 503.
  const access = await anyRoleGroup(caller.cognitoUsername);
  if (!access.ok) return access;
  // Shared pool (ADR-016): users can change their own email there, and the STS issuer
  // otherwise derives the role from the email. Pin the role to custom:subdomain so an
  // email change cannot mint a fresh role and budget identity (ensure_role refuses a
  // role owned by another email). Fails closed.
  if (shared()) {
    try {
      const fresh = await pin(caller.cognitoUsername as string);
      // The session/token copies can be stale (8h JWT, stored CLI token row): the record
      // looked up must be the caller's own, and ensure_role gets only its fresh values.
      if (fresh.sub !== identity.sub) {
        return { ok: false, response: NextResponse.json({ error: "Identity mismatch" }, { status: 403 }) };
      }
      identity.subdomain = fresh.subdomain;
      identity.email = fresh.email;
      identity.pool = userPoolId;
    } catch (err) {
      console.error("[local/credentials] subdomain pin failed:", err instanceof Error ? err.message : err);
      return { ok: false, response: NextResponse.json({ error: "Identity check unavailable" }, { status: 503 }) };
    }
  }
  return { ok: true, identity };
}

/**
 * Bearer-only CLI authentication (no session cookie, no `ccb_` token): a Cognito access
 * token of the CLI public client, verified by GetUser, then `freshCallerChecks`.
 */
export async function authenticateCliAccessToken(
  req: Request,
  deps: {
    resolve?: (token: string) => Promise<ResolvedCaller | null>;
    checks?: (caller: ResolvedCaller) => Promise<CallerCheck>;
  } = {}
): Promise<{ ok: true; caller: ResolvedCaller } | { ok: false; response: NextResponse }> {
  const unauthorized = {
    ok: false as const,
    response: NextResponse.json({ error: "Authentication required" }, { status: 401 }),
  };
  const token = bearerToken(req);
  if (!token || !isCognitoJwt(token)) return unauthorized;
  const caller = await (deps.resolve ?? ((t: string) => resolveCognitoAccessToken(t)))(token);
  if (!caller) return unauthorized;
  const checked = await (deps.checks ?? ((c: ResolvedCaller) => freshCallerChecks(c)))(caller);
  if (!checked.ok) return checked;
  return { ok: true, caller };
}
