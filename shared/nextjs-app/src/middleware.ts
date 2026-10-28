import { getToken } from "next-auth/jwt";
import { NextRequest, NextResponse } from "next/server";
import { DEPT_PATHS, isAllowedPath } from "@/lib/route-access";

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Public API endpoints
  if (path.startsWith("/api/health")) {
    return NextResponse.next();
  }

  // Auth API endpoints - always pass through
  if (path.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Get JWT token — cookie name matches auth.ts prefix logic
  const useSecure = process.env.NODE_ENV === "production" ||
    (process.env.NEXTAUTH_URL?.startsWith("https") ?? false);
  const cookieName = useSecure
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
    cookieName,
  });

  // API routes: return JSON errors instead of redirects
  if (path.startsWith("/api/")) {
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const groups = (token.groups as string[]) ?? [];
    // Admin-only API routes (APPROVER_PATHS also admit dept-manager) and dept-manager routes
    if (!isAllowedPath(path, groups)) {
      const error = DEPT_PATHS.some((p) => path.startsWith(p))
        ? "Dept manager access required"
        : "Admin access required";
      return NextResponse.json({ error }, { status: 403 });
    }
    return NextResponse.next();
  }

  // Not authenticated → redirect to signin
  if (!token) {
    const signInUrl = new URL("/api/auth/signin", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  const groups = (token.groups as string[]) ?? [];

  // Admin-only routes (/admin/approvals also admits dept-manager); dept routes need dept-manager or admin
  if (!isAllowedPath(path, groups)) {
    const home = DEPT_PATHS.some((p) => path.startsWith(p)) ? "/user" : "/";
    return NextResponse.redirect(new URL(home, req.url));
  }

  // User routes - any authenticated user (already checked above)
  // /user/* is accessible to all authenticated users

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/analytics/:path*",
    "/monitoring/:path*",
    "/admin/:path*",
    "/security/:path*",
    "/ai/:path*",
    "/user/:path*",
    "/dept/:path*",
    "/api/containers/:path*",
    "/api/users/:path*",
    "/api/dept/:path*",
    "/api/usage/:path*",
    "/api/container-metrics/:path*",
    "/api/security/:path*",
    "/api/admin/:path*",
    "/api/ai/:path*",
    "/api/user/:path*",
    "/docs/:path*",
    "/",
  ],
};
