// Mirrors the Cognito User Pool password policy (terraform/modules/security):
// 8-128 chars, an uppercase letter, a number and a symbol. Shared by the login
// page, the account settings forms and the password API routes so the client
// and server reject the same inputs before Cognito does.

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
    return `Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters`;
  }
  if (!/[A-Z]/.test(pw)) return "Password must contain an uppercase letter";
  if (!/[0-9]/.test(pw)) return "Password must contain a number";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password must contain a special character";
  return null;
}
