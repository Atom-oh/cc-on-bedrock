import { NextRequest } from "next/server";
import { confirmForgotPassword } from "@/lib/cognito-password";
import { badRequest, checkNewPassword, normalizeEmail, readJson, toResponse } from "@/lib/password-request";

// Public: finish a forgot-password reset with the emailed verification code.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const email = normalizeEmail(body?.email);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email || !/^\d{4,10}$/.test(code)) return badRequest("invalid_request");
  const invalid = checkNewPassword(body?.newPassword);
  if (invalid) return invalid;
  return toResponse(await confirmForgotPassword(email, code, body!.newPassword as string));
}
