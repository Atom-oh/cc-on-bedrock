import { NextRequest, NextResponse } from "next/server";
import type { PasswordErrorCode, PasswordResult } from "@/lib/cognito-password";
import { validatePassword } from "@/lib/password-policy";

// Request parsing + response shaping shared by the /api/auth/password/* routes.

const STATUS: Record<PasswordErrorCode, number> = {
  invalid_credentials: 401,
  invalid_password: 400,
  code_mismatch: 400,
  code_expired: 400,
  too_many_attempts: 429,
  not_required: 409,
  challenge_required: 409,
  unknown: 500,
};

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const email = v.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function badRequest(error: string, message?: string): NextResponse {
  return NextResponse.json({ error, ...(message ? { message } : {}) }, { status: 400 });
}

/** null when the new password passes the pool policy, else the 400 response. */
export function checkNewPassword(pw: unknown): NextResponse | null {
  const msg = validatePassword(pw);
  return msg ? badRequest("invalid_password", msg) : null;
}

export function toResponse(result: PasswordResult): NextResponse {
  if (result.ok) return NextResponse.json({ success: true });
  return NextResponse.json({ error: result.code }, { status: STATUS[result.code] });
}
