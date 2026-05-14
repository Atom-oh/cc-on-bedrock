import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Serves the raw cc-bedrock-local.sh script from the repo's tools/ directory.
// Public (no auth) — the script itself does not contain secrets; auth happens
// at runtime when the user enters Cognito credentials.

let cachedScript: string | null = null;

function loadScript(): string {
  if (cachedScript) return cachedScript;
  // tools/cc-bedrock-local.sh is copied next to the Next standalone bundle at build time
  // via Dockerfile (added in the same PR). We look in a few likely locations to be robust.
  const candidates = [
    path.join(process.cwd(), "public", "tools", "cc-bedrock-local.sh"),
    path.join(process.cwd(), "tools", "cc-bedrock-local.sh"),
    path.resolve(__dirname, "../../../../../../tools/cc-bedrock-local.sh"),
    path.resolve(__dirname, "../../../../../../../tools/cc-bedrock-local.sh"),
  ];
  for (const p of candidates) {
    try {
      const s = fs.readFileSync(p, "utf8");
      cachedScript = s;
      return s;
    } catch {
      /* try next */
    }
  }
  throw new Error(`cc-bedrock-local.sh not found in: ${candidates.join(", ")}`);
}

export async function GET() {
  try {
    const body = loadScript();
    return new NextResponse(body, {
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
