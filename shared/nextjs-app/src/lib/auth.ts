import type { NextAuthOptions, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import CognitoProvider from "next-auth/providers/cognito";
import CredentialsProvider from "next-auth/providers/credentials";
import { CognitoIdentityProviderClient, InitiateAuthCommand, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { createHmac } from "crypto";
import type { UserSession } from "./types";
import { NEW_PASSWORD_REQUIRED } from "./auth-errors";
import { requiresRoleGroup, rolesFromGroupNames, type Role } from "./roles";

const cognitoClientSecret = process.env.COGNITO_CLIENT_SECRET;

function getSecretHash(username: string, clientId: string) {
  if (!cognitoClientSecret) return undefined;
  return createHmac("sha256", cognitoClientSecret)
    .update(username + clientId)
    .digest("base64");
}

/** cc roles (prefix stripped) from an IdToken's `cognito:groups`; [] when absent or malformed. */
export function rolesFromIdToken(idToken: string | undefined, prefix?: string): Role[] {
  if (!idToken) return [];
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString());
    const raw = payload["cognito:groups"];
    return rolesFromGroupNames(Array.isArray(raw) ? raw.map(String) : [], prefix);
  } catch {
    return [];
  }
}

/** Shared pool: sign-in is refused without a cc role group. Own pool: always allowed. */
export function signInAllowed(roles: Role[], prefix?: string): boolean {
  return !requiresRoleGroup(prefix) || roles.length > 0;
}

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
    department?: string;
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
      clientSecret: cognitoClientSecret ?? "",
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
        const secretHash = getSecretHash(credentials.email, clientId);
        try {
          const authResult = await cognitoClient.send(new InitiateAuthCommand({
            AuthFlow: "USER_PASSWORD_AUTH",
            ClientId: clientId,
            AuthParameters: {
              USERNAME: credentials.email,
              PASSWORD: credentials.password,
              ...(secretHash ? { SECRET_HASH: secretHash } : {}),
            },
          }));
          // Invited user on first login: the login page switches to the
          // set-new-password form (NextAuth passes the message as `error`).
          if (authResult.ChallengeName === "NEW_PASSWORD_REQUIRED") {
            throw new Error(NEW_PASSWORD_REQUIRED);
          }
          const accessToken = authResult.AuthenticationResult?.AccessToken;
          if (!accessToken) return null;
          const idToken = authResult.AuthenticationResult?.IdToken;
          // Shared pool: another app's user (no cc role group) gets the same generic
          // failure as a wrong password, so group membership is not disclosed.
          if (!signInAllowed(rolesFromIdToken(idToken))) return null;
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
            idToken,
            groups: [], // Will be populated from idToken in jwt callback
            ...attrs,
          };
        } catch (err) {
          // Only the temporary-password challenge is surfaced: it requires the
          // right password. PasswordResetRequiredException is returned before the
          // password is checked, so it stays a generic failure (no account probing);
          // those users recover through "Forgot password?".
          if ((err as Error).message === NEW_PASSWORD_REQUIRED) throw err;
          console.error("[auth] Cognito InitiateAuth failed:", (err as Error).message);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    // Second gate for both providers (the OAuth path has no authorize step).
    async signIn({ account, profile, user }) {
      if (account?.provider === "cognito") {
        const raw = (profile as Record<string, unknown> | undefined)?.["cognito:groups"];
        return signInAllowed(rolesFromGroupNames(Array.isArray(raw) ? raw.map(String) : []));
      }
      if (account?.provider === "cognito-credentials") {
        const idToken = (user as unknown as Record<string, unknown>).idToken as string | undefined;
        return signInAllowed(rolesFromIdToken(idToken));
      }
      return true;
    },
    async jwt({ token, account, profile, user }): Promise<JWT> {
      // OAuth flow (CognitoProvider)
      if (account?.provider === "cognito" && profile) {
        token.accessToken = account.access_token;
        const cognitoGroups = (profile as Record<string, unknown>)["cognito:groups"];
        // Normalized to cc role names (prefix stripped, other apps' groups dropped).
        token.groups = rolesFromGroupNames(Array.isArray(cognitoGroups) ? cognitoGroups.map(String) : []);
        const p = profile as Record<string, unknown>;
        token.subdomain = (p["custom:subdomain"] as string) ?? undefined;
        token.department = (p["custom:department"] as string) ?? undefined;
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
        token.department = (u["custom:department"] as string) ?? undefined;
        token.containerOs = (u["custom:container_os"] as string) ?? undefined;
        token.resourceTier = (u["custom:resource_tier"] as string) ?? undefined;
        token.securityPolicy = (u["custom:security_policy"] as string) ?? undefined;
        token.containerId = (u["custom:container_id"] as string) ?? undefined;
        token.storageType = (u["custom:storage_type"] as string) ?? undefined;
        // Decode groups from idToken, normalized to cc role names
        const idToken = u.idToken as string | undefined;
        if (idToken) token.groups = rolesFromIdToken(idToken);
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
        isDeptManager: groups.includes("dept-manager"),
        subdomain: token.subdomain,
        department: token.department,
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
    const cookieDomain = process.env.COOKIE_DOMAIN || undefined;
    const opts = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: useSecure, ...(cookieDomain ? { domain: cookieDomain } : {}) };
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
