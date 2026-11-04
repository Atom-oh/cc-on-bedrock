import { NextResponse } from "next/server";
import { installerEnv } from "@/lib/install-env";
import { windowsInstallerScript } from "@/lib/windows-installer";

// Force dynamic — must read process.env at request time, not module init time
export const dynamic = "force-dynamic";

// Windows counterpart of /api/install (ADR-006); script body in lib/windows-installer.ts.
export async function GET() {
  return new NextResponse(windowsInstallerScript(installerEnv()), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
