import { describe, it, expect, vi } from "vitest";
import { NextResponse } from "next/server";
import { GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import {
  authenticateCliAccessToken,
  bearerToken,
  decodeJwtPayload,
  freshCallerChecks,
  resolveCognitoAccessToken,
  type ResolvedCaller,
} from "../cli-auth";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "RS256", kid: "k" })}.${b64(claims)}.sig`;
const CLI = "cli-client-id";

const getUserOk = () =>
  vi.fn(async (_c: unknown) => ({
    Username: "u-123",
    UserAttributes: [
      { Name: "sub", Value: "sub-1" },
      { Name: "email", Value: "Jane@x.com" },
      { Name: "custom:department", Value: "eng" },
      { Name: "custom:subdomain", Value: "jane" },
    ],
  }));

describe("decodeJwtPayload", () => {
  it("decodes a three-part token", () => {
    expect(decodeJwtPayload(jwt({ a: 1 }))).toEqual({ a: 1 });
  });
  it.each(["", "a.b", "a.b.c.d", "x.!!!.y", `${b64({})}.${Buffer.from("null").toString("base64url")}.s`])(
    "rejects %j",
    (t) => {
      expect(decodeJwtPayload(t)).toBeNull();
    }
  );
});

describe("resolveCognitoAccessToken", () => {
  it("accepts a CLI-client access token and maps GetUser attributes", async () => {
    const send = getUserOk();
    const r = await resolveCognitoAccessToken(jwt({ token_use: "access", client_id: CLI }), send, CLI);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetUserCommand);
    expect(r).toEqual({
      identity: { sub: "sub-1", username: "jane", email: "Jane@x.com", department: "eng", project: "default" },
      cognitoUsername: "u-123",
      cognitoSubdomain: "jane",
    });
    // custom:subdomain stays off the STS identity (only the shared-pool pin sets it).
    expect(r?.identity.subdomain).toBeUndefined();
  });

  it("rejects another client's token without calling Cognito", async () => {
    const send = getUserOk();
    await expect(resolveCognitoAccessToken(jwt({ token_use: "access", client_id: "dashboard" }), send, CLI)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([{ token_use: "id", client_id: CLI }, { client_id: CLI }])("rejects token_use other than access (%j)", async (claims) => {
    const send = getUserOk();
    await expect(resolveCognitoAccessToken(jwt(claims), send, CLI)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when COGNITO_CLI_CLIENT_ID is empty", async () => {
    const send = getUserOk();
    await expect(resolveCognitoAccessToken(jwt({ token_use: "access", client_id: "" }), send, "")).resolves.toBeNull();
    await expect(resolveCognitoAccessToken(jwt({ token_use: "access" }), send, "")).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("reads the client id from the environment by default (unset = fail closed)", async () => {
    const prev = process.env.COGNITO_CLI_CLIENT_ID;
    delete process.env.COGNITO_CLI_CLIENT_ID;
    try {
      const send = getUserOk();
      await expect(resolveCognitoAccessToken(jwt({ token_use: "access", client_id: CLI }), send)).resolves.toBeNull();
      expect(send).not.toHaveBeenCalled();
      process.env.COGNITO_CLI_CLIENT_ID = CLI;
      await expect(resolveCognitoAccessToken(jwt({ token_use: "access", client_id: CLI }), send)).resolves.not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.COGNITO_CLI_CLIENT_ID;
      else process.env.COGNITO_CLI_CLIENT_ID = prev;
    }
  });

  it("returns null when GetUser rejects the token", async () => {
    const send = vi.fn(async () => {
      throw new Error("NotAuthorizedException");
    });
    await expect(resolveCognitoAccessToken(jwt({ token_use: "access", client_id: CLI }), send, CLI)).resolves.toBeNull();
  });
});

describe("bearerToken", () => {
  const req = (h?: string) => new Request("https://x/api", { headers: h ? { authorization: h } : {} });
  it("extracts the token", () => expect(bearerToken(req("Bearer abc"))).toBe("abc"));
  it("is case-insensitive on the scheme", () => expect(bearerToken(req("bearer abc"))).toBe("abc"));
  it.each([undefined, "Basic abc", "Bearer   "])("returns null for %j", (h) => expect(bearerToken(req(h))).toBeNull());
});

describe("freshCallerChecks", () => {
  const caller = (): ResolvedCaller => ({
    identity: { sub: "sub-1", username: "jane", email: "Jane@x.com", department: "eng", project: "default" },
    cognitoUsername: "u-123",
  });
  const allow = vi.fn(async () => ({ ok: true as const }));

  it("own pool: passes the identity through unchanged", async () => {
    const pin = vi.fn();
    const r = await freshCallerChecks(caller(), { anyRoleGroup: allow, pin, shared: () => false });
    expect(r.ok && r.identity.subdomain).toBe(undefined);
    expect(pin).not.toHaveBeenCalled();
  });

  it("returns the role-group denial (disabled user / no group)", async () => {
    const denied = NextResponse.json({ error: "Access denied" }, { status: 403 });
    const r = await freshCallerChecks(caller(), {
      anyRoleGroup: async () => ({ ok: false as const, response: denied }),
      shared: () => false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("shared pool: pins the fresh subdomain/email", async () => {
    const pin = vi.fn(async () => ({ subdomain: "jane-k", sub: "sub-1", email: "jane@x.com" }));
    const r = await freshCallerChecks(caller(), { anyRoleGroup: allow, pin, shared: () => true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toMatchObject({ subdomain: "jane-k", email: "jane@x.com" });
  });

  it("shared pool: sub mismatch is 403, pin failure 503", async () => {
    const mismatch = await freshCallerChecks(caller(), {
      anyRoleGroup: allow,
      pin: async () => ({ subdomain: "x", sub: "other", email: "x@x.com" }),
      shared: () => true,
    });
    expect(!mismatch.ok && mismatch.response.status).toBe(403);
    const failed = await freshCallerChecks(caller(), {
      anyRoleGroup: allow,
      pin: async () => {
        throw new Error("boom");
      },
      shared: () => true,
    });
    expect(!failed.ok && failed.response.status).toBe(503);
  });
});

describe("authenticateCliAccessToken", () => {
  const req = (h?: string) => new Request("https://x/api/local/sessions", { method: "POST", headers: h ? { authorization: h } : {} });
  const okCaller: ResolvedCaller = {
    identity: { sub: "s", username: "u", email: "u@x.com", department: "d", project: "default" },
  };

  it.each([undefined, "Bearer ccb_longlivedtoken"])("401 without a Cognito JWT (%j)", async (h) => {
    const resolve = vi.fn();
    const r = await authenticateCliAccessToken(req(h), { resolve });
    expect(!r.ok && r.response.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("401 when the token does not resolve", async () => {
    const r = await authenticateCliAccessToken(req(`Bearer ${jwt({})}`), { resolve: async () => null });
    expect(!r.ok && r.response.status).toBe(401);
  });

  it("applies the fresh checks", async () => {
    const denied = NextResponse.json({ error: "Access denied" }, { status: 403 });
    const r = await authenticateCliAccessToken(req(`Bearer ${jwt({})}`), {
      resolve: async () => okCaller,
      checks: async () => ({ ok: false, response: denied }),
    });
    expect(!r.ok && r.response.status).toBe(403);
    const ok = await authenticateCliAccessToken(req(`Bearer ${jwt({})}`), {
      resolve: async () => okCaller,
      checks: async (c) => ({ ok: true, identity: c.identity }),
    });
    expect(ok.ok).toBe(true);
  });
});
