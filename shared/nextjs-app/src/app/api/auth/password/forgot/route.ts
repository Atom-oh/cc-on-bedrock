import { NextRequest, NextResponse } from "next/server";
import { startForgotPassword } from "@/lib/cognito-password";
import { badRequest, normalizeEmail, readJson } from "@/lib/password-request";

// Public: send a reset code (or, for a never-signed-in invitee, a new invitation).
// The response is identical whether or not the account exists.
export async function POST(req: NextRequest) {
  const email = normalizeEmail((await readJson(req))?.email);
  if (!email) return badRequest("invalid_request");
  const result = await startForgotPassword(email);
  if (!result.ok) return NextResponse.json({ error: result.code }, { status: 429 });
  return NextResponse.json({ success: true });
}
