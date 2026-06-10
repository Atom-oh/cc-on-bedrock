import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { customRoutesPayloadSchema } from "@/lib/validation";
import { getCustomRoutes, putCustomRoutes } from "@/lib/ec2-clients";
import { mirrorCustomRoutes } from "@/lib/aws-clients";

export async function GET() {
  const session = await getServerSession(authOptions);
  const subdomain = session?.user?.subdomain;
  if (!subdomain) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { customRoutes, routesVersion, routeStatus } = await getCustomRoutes(subdomain);
    return NextResponse.json({
      success: true,
      data: { routes: customRoutes, version: routesVersion, status: routeStatus ?? [] },
    });
  } catch (err) {
    console.error("[custom-routes] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  const subdomain = session?.user?.subdomain;
  if (!subdomain) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = customRoutesPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  try {
    const { routesVersion } = await getCustomRoutes(subdomain);
    const newVersion = await putCustomRoutes(subdomain, parsed.data.routes, routesVersion);
    const { mirrored } = await mirrorCustomRoutes(subdomain, parsed.data.routes, newVersion);
    return NextResponse.json({
      success: true,
      data: { version: newVersion, applied: mirrored, pending: !mirrored },
    });
  } catch (err) {
    if (err instanceof Error && err.message === "version-conflict") {
      return NextResponse.json(
        { success: false, error: "동시 수정이 감지되었습니다. 새로고침 후 다시 시도하세요." },
        { status: 409 },
      );
    }
    console.error("[custom-routes] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
