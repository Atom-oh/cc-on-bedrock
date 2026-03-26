import { getToken } from "next-auth/jwt";
import { NextRequest, NextResponse } from "next/server";

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

  // Get JWT token using custom cookie name (CloudFront→ALB HTTP환경)
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
    cookieName: "next-auth.session-token",
  });

  // Not authenticated
  if (!token) {
    // API routes: return 401 (don't redirect)
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const signInUrl = new URL("/api/auth/signin", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  // Admin-only routes
  if (path.startsWith("/admin") || path.startsWith("/monitoring")) {
    const groups = (token.groups as string[]) ?? [];
    if (!groups.includes("admin")) {
      return NextResponse.redirect(new URL("/", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/analytics/:path*",
    "/monitoring/:path*",
    "/admin/:path*",
    "/security/:path*",
    "/ai/:path*",
    "/",
    "/api/((?!health|auth|ai/runtime).*)",
  ],
};
