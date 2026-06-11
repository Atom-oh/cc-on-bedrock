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
    const { routesVersion, exists } = await getCustomRoutes(subdomain);
    if (!exists) {
      // M9: no instance record — don't create a phantom row; require an environment first.
      return NextResponse.json(
        { success: false, error: "먼저 개발 환경을 시작한 뒤 포트를 설정하세요." },
        { status: 409 },
      );
    }
    // M3: if the client echoed the version it loaded, use it as the CAS expectedVersion so a
    // stale edit (another tab saved meanwhile) gets a 409 instead of silently overwriting.
    const expectedVersion = parsed.data.version ?? routesVersion;
    const newVersion = await putCustomRoutes(subdomain, parsed.data.routes, expectedVersion);
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
