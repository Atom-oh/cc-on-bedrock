import { NextResponse } from "next/server";
import { loadToolScript } from "@/lib/tool-script";

// Serves the raw cc-bedrock-local.sh script from the repo's tools/ directory.
// Public (no auth) — the script itself does not contain secrets; auth happens
// at runtime when the user enters Cognito credentials.
export async function GET() {
  try {
    return new NextResponse(loadToolScript("cc-bedrock-local.sh"), {
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
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
