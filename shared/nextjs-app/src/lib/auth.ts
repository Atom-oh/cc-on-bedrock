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
    containerId?: string;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CognitoProvider({
      clientId: process.env.COGNITO_CLIENT_ID!,
      clientSecret: process.env.COGNITO_CLIENT_SECRET!,
      issuer: process.env.COGNITO_ISSUER!,
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
  // Custom cookie names (without __Secure- prefix) for CloudFront → ALB environment.
  // secure: true — CloudFront always sends HTTPS to viewer, and ALB sets X-Forwarded-Proto.
  // NextAuth reads X-Forwarded-Proto to determine if the original request was HTTPS.
  cookies: {
    sessionToken: {
      name: "next-auth.session-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    callbackUrl: {
      name: "next-auth.callback-url",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    csrfToken: {
      name: "next-auth.csrf-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    pkceCodeVerifier: {
      name: "next-auth.pkce.code_verifier",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    state: {
      name: "next-auth.state",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
    nonce: {
      name: "next-auth.nonce",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
  },
};
