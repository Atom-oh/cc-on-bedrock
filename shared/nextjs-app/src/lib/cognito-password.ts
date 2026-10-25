import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createHmac } from "crypto";

// Self-service password flows (first-login new password, forgot/reset, change).
// Every call except the invite resend is a public Cognito API that authorizes
// with the user's own password, code or session — the dashboard role grants
// nothing extra. Errors map to a small set of codes the UI can show.

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const client = new CognitoIdentityProviderClient({ region });

export type PasswordErrorCode =
  | "invalid_credentials"
  | "invalid_password"
  | "code_mismatch"
  | "code_expired"
  | "too_many_attempts"
  | "not_required"
  | "challenge_required"
  | "unknown";

export type PasswordResult = { ok: true } | { ok: false; code: PasswordErrorCode };

function clientId(): string {
  return process.env.COGNITO_CLIENT_ID ?? "";
}

export function secretHash(username: string): string | undefined {
  const secret = process.env.COGNITO_CLIENT_SECRET;
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(username + clientId()).digest("base64");
}

// Auth flows take the hash inside AuthParameters/ChallengeResponses as
// SECRET_HASH; ForgotPassword/ConfirmForgotPassword take a top-level SecretHash.
function withSecret(username: string): { SECRET_HASH?: string } {
  const h = secretHash(username);
  return h ? { SECRET_HASH: h } : {};
}

function withSecretHash(username: string): { SecretHash?: string } {
  const h = secretHash(username);
  return h ? { SecretHash: h } : {};
}

export function mapCognitoError(err: unknown): PasswordErrorCode {
  switch ((err as { name?: string })?.name) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
      return "invalid_credentials";
    case "InvalidPasswordException":
      return "invalid_password";
    case "CodeMismatchException":
      return "code_mismatch";
    case "ExpiredCodeException":
      return "code_expired";
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return "too_many_attempts";
    default:
      return "unknown";
  }
}

function fail(err: unknown, op: string): PasswordResult {
  const code = mapCognitoError(err);
  if (code === "unknown") console.error(`[cognito-password] ${op}:`, err instanceof Error ? err.message : err);
  return { ok: false, code };
}

async function passwordAuth(email: string, password: string) {
  return client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId(),
      AuthParameters: { USERNAME: email, PASSWORD: password, ...withSecret(email) },
    })
  );
}

/** First login of an invited user: temporary password → permanent password. */
export async function completeNewPassword(email: string, tempPassword: string, newPassword: string): Promise<PasswordResult> {
  try {
    const auth = await passwordAuth(email, tempPassword);
    if (auth.ChallengeName !== "NEW_PASSWORD_REQUIRED" || !auth.Session) {
      return { ok: false, code: "not_required" };
    }
    await client.send(
      new RespondToAuthChallengeCommand({
        ClientId: clientId(),
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: auth.Session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword, ...withSecret(email) },
      })
    );
    return { ok: true };
  } catch (err) {
    return fail(err, "completeNewPassword");
  }
}

/**
 * Forgot password. Always resolves without revealing whether the account exists.
 * An invited user who never signed in (FORCE_CHANGE_PASSWORD) cannot use the code
 * flow, so they get the invitation (a fresh temporary password) re-sent instead.
 */
export async function startForgotPassword(email: string): Promise<{ ok: true }> {
  try {
    await client.send(new ForgotPasswordCommand({ ClientId: clientId(), Username: email, ...withSecretHash(email) }));
    return { ok: true };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    // Cognito throttles per account, so a distinct "slow down" reply would tell
    // an existing account from a missing one; throttling stays silent too.
    if (mapCognitoError(err) === "too_many_attempts") return { ok: true };
    if (name === "NotAuthorizedException") await resendInviteIfPending(email);
    else if (name !== "UserNotFoundException") {
      console.error("[cognito-password] startForgotPassword:", err instanceof Error ? err.message : err);
    }
    return { ok: true };
  }
}

// The resend replaces the temporary password and is reachable without signing
// in, so it is throttled per account: a RESEND bumps UserLastModifiedDate, and
// no new invitation goes out within this window of the last change.
export const INVITE_RESEND_COOLDOWN_MS = 15 * 60 * 1000;

async function resendInviteIfPending(email: string, now: number = Date.now()): Promise<void> {
  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
  try {
    const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    if (!user.Enabled || user.UserStatus !== "FORCE_CHANGE_PASSWORD") return;
    const lastChange = user.UserLastModifiedDate ? new Date(user.UserLastModifiedDate).getTime() : 0;
    if (now - lastChange < INVITE_RESEND_COOLDOWN_MS) return;
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        MessageAction: "RESEND",
        DesiredDeliveryMediums: ["EMAIL"],
      })
    );
  } catch (err) {
    console.error("[cognito-password] invite resend:", err instanceof Error ? err.message : err);
  }
}

export async function confirmForgotPassword(email: string, code: string, newPassword: string): Promise<PasswordResult> {
  try {
    await client.send(
      new ConfirmForgotPasswordCommand({
        ClientId: clientId(),
        Username: email,
        ConfirmationCode: code,
        Password: newPassword,
        ...withSecretHash(email),
      })
    );
    return { ok: true };
  } catch (err) {
    return fail(err, "confirmForgotPassword");
  }
}

/** Signed-in change: re-authenticates with the current password, so a hijacked session alone cannot change it. */
export async function changePassword(email: string, currentPassword: string, newPassword: string): Promise<PasswordResult> {
  try {
    const auth = await passwordAuth(email, currentPassword);
    const accessToken = auth.AuthenticationResult?.AccessToken;
    // A challenge (e.g. MFA) means the password was right but no token was issued.
    if (!accessToken) return { ok: false, code: auth.ChallengeName ? "challenge_required" : "invalid_credentials" };
    await client.send(
      new ChangePasswordCommand({ AccessToken: accessToken, PreviousPassword: currentPassword, ProposedPassword: newPassword })
    );
    return { ok: true };
  } catch (err) {
    return fail(err, "changePassword");
  }
}
