import { NextResponse } from "next/server";
import { getProxyHealth } from "@/lib/litellm-client";

export async function GET() {
  const checks: Record<string, { status: string; message?: string }> = {};

  // Dashboard self-check
  checks["dashboard"] = { status: "healthy" };

  // LiteLLM proxy health check
  try {
    const proxyHealth = await getProxyHealth();
    checks["litellm_proxy"] = {
      status: proxyHealth.status === "connected" ? "healthy" : "degraded",
      message: proxyHealth.status,
    };
  } catch (err) {
    checks["litellm_proxy"] = {
      status: "unhealthy",
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }

  const allHealthy = Object.values(checks).every(
    (c) => c.status === "healthy"
  );

  return NextResponse.json(
    {
      status: allHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allHealthy ? 200 : 503 }
  );
}
