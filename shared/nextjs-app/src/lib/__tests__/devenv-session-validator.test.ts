import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
// Import the ACTUAL Lambda@Edge validator (CommonJS) so this is a real regression
// guard, not a copy. M1 (PR #91 review): COOKIE_DOMAIN=.<domain> broadens the
// dashboard session cookie to user-controlled *.dev origins, so the devenv path
// MUST strip the NextAuth session token before forwarding. Lock that in.
const require = createRequire(import.meta.url);
const validator = require("../../../../../lambda/devenv-session-validator/index.js");
const { stripNextAuthCookies, NEXTAUTH_COOKIE_PREFIXES } = validator;

// CloudFront Lambda@Edge request.headers shape: { cookie: [{ key, value }] }
function headersWithCookie(value: string) {
  return { cookie: [{ key: "Cookie", value }] } as Record<
    string,
    { key: string; value: string }[]
  >;
}

function forwardedCookie(headers: Record<string, { key: string; value: string }[]>) {
  return headers.cookie ? headers.cookie.map((c) => c.value).join("; ") : "";
}

describe("devenv-session-validator stripNextAuthCookies (M1 session-token leak guard)", () => {
  it("strips the secure session token before forwarding to the devenv origin", () => {
    const h = headersWithCookie(
      "__Secure-next-auth.session-token=SUPERSECRET; code_server_session=keepme",
    );
    stripNextAuthCookies(h);
    const fwd = forwardedCookie(h);
    expect(fwd).not.toContain("SUPERSECRET");
    expect(fwd).not.toContain("next-auth.session-token");
    expect(fwd).toContain("code_server_session=keepme");
  });

  it("strips the unsecured (http) next-auth session token too", () => {
    const h = headersWithCookie("next-auth.session-token=PLAINSECRET; foo=bar");
    stripNextAuthCookies(h);
    const fwd = forwardedCookie(h);
    expect(fwd).not.toContain("PLAINSECRET");
    expect(fwd).toBe("foo=bar");
  });

  it("strips every NextAuth-prefixed cookie (csrf, callback, etc.), not just the token", () => {
    const h = headersWithCookie(
      "__Secure-next-auth.csrf-token=x; __Secure-next-auth.callback-url=y; ok=1",
    );
    stripNextAuthCookies(h);
    expect(forwardedCookie(h)).toBe("ok=1");
  });

  it("removes the Cookie header entirely when only NextAuth cookies were present", () => {
    const h = headersWithCookie("__Secure-next-auth.session-token=only");
    stripNextAuthCookies(h);
    expect(h.cookie).toBeUndefined();
  });

  it("leaves non-NextAuth cookies untouched", () => {
    const h = headersWithCookie("a=1; b=2");
    stripNextAuthCookies(h);
    expect(forwardedCookie(h)).toBe("a=1; b=2");
  });

  it("exposes the strip prefixes as a single source of truth covering the session token", () => {
    expect(NEXTAUTH_COOKIE_PREFIXES).toContain("__Secure-next-auth.");
    expect(NEXTAUTH_COOKIE_PREFIXES).toContain("next-auth.");
    // The real session-token cookie names must be covered by a prefix.
    for (const name of ["__Secure-next-auth.session-token", "next-auth.session-token"]) {
      expect(NEXTAUTH_COOKIE_PREFIXES.some((p: string) => name.startsWith(p))).toBe(true);
    }
  });
});
