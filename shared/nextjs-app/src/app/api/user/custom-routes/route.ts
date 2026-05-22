import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  customRoutesPayloadSchema,
  RESERVED_PATHS,
  RESERVED_PORTS,
} from "@/lib/validation";
import { getCustomRoutes, setCustomRoutes } from "@/lib/aws-clients";

const LIMITS: Record<"open" | "restricted" | "locked", number> = {
  open: 10,
  restricted: 3,
  locked: 0,
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.subdomain) {
    return NextResponse.json(
      { success: false, error: "Not authenticated or no subdomain" },
      { status: 401 },
    );
  }

  const policy = (session.user.securityPolicy ?? "restricted") as "open" | "restricted" | "locked";
  const maxAllowed = LIMITS[policy] ?? 0;
  const routes = await getCustomRoutes(session.user.subdomain);

  return NextResponse.json({
    success: true,
    data: {
      routes,
      maxAllowed,
      reservedPaths: RESERVED_PATHS,
      reservedPorts: RESERVED_PORTS,
      securityPolicy: policy,
    },
  });
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.subdomain) {
    return NextResponse.json(
      { success: false, error: "Not authenticated or no subdomain" },
      { status: 401 },
    );
  }

  const policy = (session.user.securityPolicy ?? "restricted") as "open" | "restricted" | "locked";
  if (policy === "locked") {
    return NextResponse.json(
      { success: false, error: "Custom routes are disabled for locked security policy" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = customRoutesPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const tierLimit = LIMITS[policy] ?? 0;
  if (parsed.data.routes.length > tierLimit) {
    return NextResponse.json(
      {
        success: false,
        error: `Maximum ${tierLimit} custom routes for ${policy} security policy`,
      },
      { status: 400 },
    );
  }

  await setCustomRoutes(session.user.subdomain, parsed.data.routes);

  return NextResponse.json({
    success: true,
    data: {
      routes: parsed.data.routes,
      updatedAt: new Date().toISOString(),
    },
  });
}
