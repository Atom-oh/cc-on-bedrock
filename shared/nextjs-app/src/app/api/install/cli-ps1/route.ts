import { NextResponse } from "next/server";
import { loadToolScript } from "@/lib/tool-script";

// Serves tools/cc-bedrock-local.ps1, the Windows Local CLI (ADR-006). Public (no
// auth) like /api/install/cli: the script holds no secrets; the user signs in
// with Cognito at runtime.
export async function GET() {
  try {
    return new NextResponse(loadToolScript("cc-bedrock-local.ps1"), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return new NextResponse(`# error: ${msg}\n`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
