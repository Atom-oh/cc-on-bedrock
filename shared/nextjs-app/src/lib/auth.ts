import type { NextAuthOptions, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import CognitoProvider from "next-auth/providers/cognito";
import type { UserSession } from "./types";

declare module "next-auth" {
  interface Session {
    user: UserSession;
    accessToken?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    groups?: string[];
    accessToken?: string;
    subdomain?: string;
    containerOs?: string;
    resourceTier?: string;
    securityPolicy?: string;
    litellmApiKey?: string;
    containerId?: string;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CognitoProvider({
      clientId: process.env.COGNITO_CLIENT_ID!,
      clientSecret: process.env.COGNITO_CLIENT_SECRET!,
      issuer: process.env.COGNITO_ISSUER!,
      authorization: { params: { scope: "openid email profile" } },
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name ?? profile.email,
          email: profile.email,
          image: null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }): Promise<JWT> {
      if (account && profile) {
        token.accessToken = account.access_token;
        // Cognito groups come in the id_token
        const cognitoGroups =
          (profile as Record<string, unknown>)["cognito:groups"];
        token.groups = Array.isArray(cognitoGroups)
          ? (cognitoGroups as string[])
          : [];
        // Custom attributes from Cognito
        const p = profile as Record<string, unknown>;
        token.subdomain = (p["custom:subdomain"] as string) ?? undefined;
        token.containerOs = (p["custom:container_os"] as string) ?? undefined;
        token.resourceTier = (p["custom:resource_tier"] as string) ?? undefined;
        token.securityPolicy =
          (p["custom:security_policy"] as string) ?? undefined;
        token.litellmApiKey =
          (p["custom:litellm_api_key"] as string) ?? undefined;
        token.containerId = (p["custom:container_id"] as string) ?? undefined;
      }
      return token;
    },
    async session({ session, token }): Promise<Session> {
      const groups = token.groups ?? [];
      session.user = {
        id: token.sub ?? "",
        email: token.email ?? "",
        name: token.name ?? undefined,
        groups,
        isAdmin: groups.includes("admin"),
        subdomain: token.subdomain,
        containerOs: token.containerOs as UserSession["containerOs"],
        resourceTier: token.resourceTier as UserSession["resourceTier"],
        securityPolicy: token.securityPolicy as UserSession["securityPolicy"],
        litellmApiKey: token.litellmApiKey,
        containerId: token.containerId,
      };
      session.accessToken = token.accessToken;
      return session;
    },
  },
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours
  },
  // Cookie security: secure=true when NEXTAUTH_URL is HTTPS (production behind CloudFront)
  // secure=false only when ALB→App uses plain HTTP (no TLS termination at ALB)
  cookies: (() => {
    const useSecure = process.env.NODE_ENV === "production" ||
      (process.env.NEXTAUTH_URL?.startsWith("https") ?? false);
    const opts = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: useSecure };
    const prefix = useSecure ? "__Secure-next-auth" : "next-auth";
    return {
      sessionToken: { name: `${prefix}.session-token`, options: opts },
      callbackUrl: { name: `${prefix}.callback-url`, options: opts },
      csrfToken: { name: `${prefix}.csrf-token`, options: opts },
      pkceCodeVerifier: { name: `${prefix}.pkce.code_verifier`, options: opts },
      state: { name: `${prefix}.state`, options: opts },
      nonce: { name: `${prefix}.nonce`, options: opts },
    };
  })(),
};
