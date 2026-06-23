import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

let cachedScript: string | null = null;

function loadScript(): string {
  if (cachedScript) return cachedScript;
  const candidates = [
    path.join(process.cwd(), "public", "tools", "cc-otel-code-metrics.sh"),
    path.join(process.cwd(), "tools", "cc-otel-code-metrics.sh"),
    path.resolve(__dirname, "../../../../../../tools/cc-otel-code-metrics.sh"),
    path.resolve(__dirname, "../../../../../../../tools/cc-otel-code-metrics.sh"),
  ];
  for (const p of candidates) {
    try {
      cachedScript = fs.readFileSync(p, "utf8");
      return cachedScript;
    } catch {
      /* try next */
    }
  }
  throw new Error(`cc-otel-code-metrics.sh not found in: ${candidates.join(", ")}`);
}

export async function GET() {
  try {
    return new NextResponse(loadScript(), {
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
