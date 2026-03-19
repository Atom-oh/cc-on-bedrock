import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    const token = req.nextauth.token;
    const path = req.nextUrl.pathname;

    // Admin-only routes
    if (path.startsWith("/admin") || path.startsWith("/monitoring")) {
      const groups = (token?.groups as string[]) ?? [];
      if (!groups.includes("admin")) {
        return NextResponse.redirect(new URL("/analytics", req.url));
      }
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
  }
);

export const config = {
  matcher: [
    "/analytics/:path*",
    "/monitoring/:path*",
    "/admin/:path*",
    "/",
  ],
};
