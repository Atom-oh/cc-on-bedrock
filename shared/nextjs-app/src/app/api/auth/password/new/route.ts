import { NextRequest } from "next/server";
import { completeNewPassword } from "@/lib/cognito-password";
import { badRequest, checkNewPassword, normalizeEmail, readJson, toResponse } from "@/lib/password-request";

// Public: first login of an invited user (Cognito NEW_PASSWORD_REQUIRED challenge).
// The temporary password authorizes the call; the client signs in afterwards.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const email = normalizeEmail(body?.email);
  if (!body || !email || typeof body.temporaryPassword !== "string" || !body.temporaryPassword) {
    return badRequest("invalid_request");
  }
  const invalid = checkNewPassword(body.newPassword);
  if (invalid) return invalid;
  return toResponse(await completeNewPassword(email, body.temporaryPassword, body.newPassword as string));
}
