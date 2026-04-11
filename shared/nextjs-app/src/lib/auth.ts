import type { NextAuthOptions, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import CognitoProvider from "next-auth/providers/cognito";
import CredentialsProvider from "next-auth/providers/credentials";
import { CognitoIdentityProviderClient, InitiateAuthCommand, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { createHmac } from "crypto";
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
    storageType?: string;
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
    CredentialsProvider({
      id: "cognito-credentials",
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const cognitoClient = new CognitoIdentityProviderClient({
          region: process.env.AWS_REGION ?? "ap-northeast-2",
        });
        const clientId = process.env.COGNITO_CLIENT_ID!;
        const clientSecret = process.env.COGNITO_CLIENT_SECRET!;
        // Compute SECRET_HASH for Cognito app client with secret
        const secretHash = createHmac("sha256", clientSecret)
          .update(credentials.email + clientId)
          .digest("base64");
        try {
          const authResult = await cognitoClient.send(new InitiateAuthCommand({
            AuthFlow: "USER_PASSWORD_AUTH",
            ClientId: clientId,
            AuthParameters: {
              USERNAME: credentials.email,
              PASSWORD: credentials.password,
              SECRET_HASH: secretHash,
            },
          }));
          const accessToken = authResult.AuthenticationResult?.AccessToken;
          if (!accessToken) return null;
          // Fetch user attributes
          const userResult = await cognitoClient.send(new GetUserCommand({ AccessToken: accessToken }));
          const attrs: Record<string, string> = {};
          for (const attr of userResult.UserAttributes ?? []) {
            if (attr.Name && attr.Value) attrs[attr.Name] = attr.Value;
          }
          return {
            id: attrs["sub"] ?? "",
            email: attrs["email"] ?? credentials.email,
            name: attrs["name"] ?? attrs["email"] ?? credentials.email,
            accessToken,
            idToken: authResult.AuthenticationResult?.IdToken,
            groups: [], // Will be populated from idToken in jwt callback
            ...attrs,
          };
        } catch (err) {
          console.error("[auth] Cognito InitiateAuth failed:", (err as Error).message);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile, user }): Promise<JWT> {
      // OAuth flow (CognitoProvider)
      if (account?.provider === "cognito" && profile) {
        token.accessToken = account.access_token;
        const cognitoGroups = (profile as Record<string, unknown>)["cognito:groups"];
        token.groups = Array.isArray(cognitoGroups) ? (cognitoGroups as string[]) : [];
        const p = profile as Record<string, unknown>;
        token.subdomain = (p["custom:subdomain"] as string) ?? undefined;
        token.containerOs = (p["custom:container_os"] as string) ?? undefined;
        token.resourceTier = (p["custom:resource_tier"] as string) ?? undefined;
        token.securityPolicy = (p["custom:security_policy"] as string) ?? undefined;
        token.containerId = (p["custom:container_id"] as string) ?? undefined;
        token.storageType = (p["custom:storage_type"] as string) ?? undefined;
      }
      // Credentials flow (cognito-credentials) — extract from user object + idToken
      if (account?.provider === "cognito-credentials" && user) {
        const u = user as unknown as Record<string, unknown>;
        token.accessToken = (u.accessToken as string) ?? undefined;
        token.subdomain = (u["custom:subdomain"] as string) ?? undefined;
        token.containerOs = (u["custom:container_os"] as string) ?? undefined;
        token.resourceTier = (u["custom:resource_tier"] as string) ?? undefined;
        token.securityPolicy = (u["custom:security_policy"] as string) ?? undefined;
        token.containerId = (u["custom:container_id"] as string) ?? undefined;
        token.storageType = (u["custom:storage_type"] as string) ?? undefined;
        // Decode groups from idToken
        const idToken = u.idToken as string | undefined;
        if (idToken) {
          try {
            const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString());
            token.groups = Array.isArray(payload["cognito:groups"]) ? payload["cognito:groups"] : [];
          } catch { token.groups = []; }
        }
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
        storageType: token.storageType as UserSession["storageType"],
      };
      session.accessToken = token.accessToken;
      return session;
    },
  },
  pages: {
    signIn: "/login",
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
