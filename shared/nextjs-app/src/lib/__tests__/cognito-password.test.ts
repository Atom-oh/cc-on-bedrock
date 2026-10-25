import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Cognito SDK so each flow's call sequence is observable without AWS.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  const mk = (name: string) =>
    function (this: { __type: string; input: unknown }, input: unknown) {
      this.__type = name;
      this.input = input;
    };
  return {
    CognitoIdentityProviderClient: function (this: { send: typeof sendMock }) {
      this.send = sendMock;
    },
    AdminCreateUserCommand: mk("AdminCreateUser"),
    AdminGetUserCommand: mk("AdminGetUser"),
    ChangePasswordCommand: mk("ChangePassword"),
    ConfirmForgotPasswordCommand: mk("ConfirmForgotPassword"),
    ForgotPasswordCommand: mk("ForgotPassword"),
    InitiateAuthCommand: mk("InitiateAuth"),
    RespondToAuthChallengeCommand: mk("RespondToAuthChallenge"),
  };
});

import {
  changePassword,
  completeNewPassword,
  confirmForgotPassword,
  INVITE_RESEND_COOLDOWN_MS,
  mapCognitoError,
  secretHash,
  startForgotPassword,
} from "@/lib/cognito-password";
import { validatePassword } from "@/lib/password-policy";
import { normalizeEmail, toResponse } from "@/lib/password-request";

type Cmd = { __type: string; input: Record<string, unknown> };
const calls = () => sendMock.mock.calls.map((c) => (c[0] as Cmd).__type);
const input = (i: number) => (sendMock.mock.calls[i][0] as Cmd).input;
const awsError = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => {
  sendMock.mockReset();
  process.env.COGNITO_CLIENT_ID = "client-1";
  process.env.COGNITO_USER_POOL_ID = "pool-1";
  delete process.env.COGNITO_CLIENT_SECRET;
});

describe("validatePassword (mirrors the pool policy)", () => {
  it("accepts a compliant password", () => {
    expect(validatePassword("Abcdef1!")).toBeNull();
  });
  it.each([
    ["Ab1!", "between 8 and 128"],
    ["A".repeat(127) + "1!", "between 8 and 128"],
    ["abcdefg1!", "uppercase"],
    ["Abcdefgh!", "number"],
    ["Abcdefgh1", "special"],
  ])("rejects %s", (pw, msg) => {
    expect(validatePassword(pw)).toContain(msg);
  });
  it("rejects non-strings", () => {
    expect(validatePassword(undefined)).not.toBeNull();
    expect(validatePassword(12345678)).not.toBeNull();
  });
});

describe("secretHash", () => {
  it("is omitted without a client secret", () => {
    expect(secretHash("a@b.c")).toBeUndefined();
  });
  it("is HMAC-SHA256(username + clientId) when a secret is set", () => {
    process.env.COGNITO_CLIENT_SECRET = "s3cret";
    const h = secretHash("a@b.c");
    expect(h).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(h).not.toBe(secretHash("other@b.c"));
  });
});

describe("mapCognitoError", () => {
  it.each([
    ["NotAuthorizedException", "invalid_credentials"],
    ["UserNotFoundException", "invalid_credentials"],
    ["InvalidPasswordException", "invalid_password"],
    ["CodeMismatchException", "code_mismatch"],
    ["ExpiredCodeException", "code_expired"],
    ["LimitExceededException", "too_many_attempts"],
    ["TooManyRequestsException", "too_many_attempts"],
    ["TooManyFailedAttemptsException", "too_many_attempts"],
    ["InternalErrorException", "unknown"],
  ])("%s → %s", (name, code) => {
    expect(mapCognitoError(awsError(name))).toBe(code);
  });
});

describe("completeNewPassword", () => {
  it("puts the secret hash inside ChallengeResponses as SECRET_HASH", async () => {
    process.env.COGNITO_CLIENT_SECRET = "s3cret";
    sendMock.mockResolvedValueOnce({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s" }).mockResolvedValueOnce({});
    await completeNewPassword("u@x.io", "Temp1!aa", "Newpass1!");
    expect((input(0).AuthParameters as Record<string, string>).SECRET_HASH).toBe(secretHash("u@x.io"));
    expect((input(1).ChallengeResponses as Record<string, string>).SECRET_HASH).toBe(secretHash("u@x.io"));
  });
  it("answers the NEW_PASSWORD_REQUIRED challenge with the session", async () => {
    sendMock.mockResolvedValueOnce({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "sess-1" }).mockResolvedValueOnce({});
    expect(await completeNewPassword("u@x.io", "Temp1!aa", "Newpass1!")).toEqual({ ok: true });
    expect(calls()).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    expect(input(1)).toMatchObject({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: "sess-1",
      ChallengeResponses: { USERNAME: "u@x.io", NEW_PASSWORD: "Newpass1!" },
    });
  });
  it("refuses when the account is not waiting for a new password", async () => {
    sendMock.mockResolvedValueOnce({ AuthenticationResult: { AccessToken: "t" } });
    expect(await completeNewPassword("u@x.io", "Real1!aa", "Newpass1!")).toEqual({ ok: false, code: "not_required" });
    expect(calls()).toEqual(["InitiateAuth"]);
  });
  it("maps a wrong or expired temporary password", async () => {
    sendMock.mockRejectedValueOnce(awsError("NotAuthorizedException"));
    expect(await completeNewPassword("u@x.io", "bad", "Newpass1!")).toEqual({ ok: false, code: "invalid_credentials" });
  });
});

describe("startForgotPassword", () => {
  it("sends a reset code", async () => {
    sendMock.mockResolvedValueOnce({});
    expect(await startForgotPassword("u@x.io")).toEqual({ ok: true });
    expect(calls()).toEqual(["ForgotPassword"]);
  });
  it("hides a missing account", async () => {
    sendMock.mockRejectedValueOnce(awsError("UserNotFoundException"));
    expect(await startForgotPassword("ghost@x.io")).toEqual({ ok: true });
    expect(calls()).toEqual(["ForgotPassword"]);
  });
  it("re-sends the invitation to an enabled, never-signed-in invitee", async () => {
    sendMock
      .mockRejectedValueOnce(awsError("NotAuthorizedException"))
      .mockResolvedValueOnce({ Enabled: true, UserStatus: "FORCE_CHANGE_PASSWORD" })
      .mockResolvedValueOnce({});
    expect(await startForgotPassword("new@x.io")).toEqual({ ok: true });
    expect(calls()).toEqual(["ForgotPassword", "AdminGetUser", "AdminCreateUser"]);
    expect(input(2)).toMatchObject({ UserPoolId: "pool-1", Username: "new@x.io", MessageAction: "RESEND" });
  });
  it("does not re-send an invitation sent within the cooldown", async () => {
    sendMock
      .mockRejectedValueOnce(awsError("NotAuthorizedException"))
      .mockResolvedValueOnce({
        Enabled: true,
        UserStatus: "FORCE_CHANGE_PASSWORD",
        UserLastModifiedDate: new Date(Date.now() - INVITE_RESEND_COOLDOWN_MS + 60_000),
      });
    expect(await startForgotPassword("new@x.io")).toEqual({ ok: true });
    expect(calls()).toEqual(["ForgotPassword", "AdminGetUser"]);
  });
  it("re-sends again once the cooldown has passed", async () => {
    sendMock
      .mockRejectedValueOnce(awsError("NotAuthorizedException"))
      .mockResolvedValueOnce({
        Enabled: true,
        UserStatus: "FORCE_CHANGE_PASSWORD",
        UserLastModifiedDate: new Date(Date.now() - INVITE_RESEND_COOLDOWN_MS - 60_000),
      })
      .mockResolvedValueOnce({});
    expect(await startForgotPassword("new@x.io")).toEqual({ ok: true });
    expect(calls()).toEqual(["ForgotPassword", "AdminGetUser", "AdminCreateUser"]);
  });
  it("does not re-send an invitation to a disabled user", async () => {
    sendMock
      .mockRejectedValueOnce(awsError("NotAuthorizedException"))
      .mockResolvedValueOnce({ Enabled: false, UserStatus: "FORCE_CHANGE_PASSWORD" });
    expect(await startForgotPassword("off@x.io")).toEqual({ ok: true });
    expect(calls()).toEqual(["ForgotPassword", "AdminGetUser"]);
  });
  it("keeps throttling silent (Cognito throttles per account)", async () => {
    sendMock.mockRejectedValueOnce(awsError("LimitExceededException"));
    expect(await startForgotPassword("u@x.io")).toEqual({ ok: true });
    expect(calls()).toEqual(["ForgotPassword"]);
  });
  it("puts the client secret hash in the top-level SecretHash field", async () => {
    process.env.COGNITO_CLIENT_SECRET = "s3cret";
    sendMock.mockResolvedValueOnce({});
    await startForgotPassword("u@x.io");
    expect(input(0).SecretHash).toBe(secretHash("u@x.io"));
    expect(input(0)).not.toHaveProperty("SECRET_HASH");
  });
});

describe("confirmForgotPassword", () => {
  it("passes the code and new password", async () => {
    sendMock.mockResolvedValueOnce({});
    expect(await confirmForgotPassword("u@x.io", "123456", "Newpass1!")).toEqual({ ok: true });
    expect(input(0)).toMatchObject({ Username: "u@x.io", ConfirmationCode: "123456", Password: "Newpass1!" });
  });
  it("puts the client secret hash in the top-level SecretHash field", async () => {
    process.env.COGNITO_CLIENT_SECRET = "s3cret";
    sendMock.mockResolvedValueOnce({});
    await confirmForgotPassword("u@x.io", "123456", "Newpass1!");
    expect(input(0).SecretHash).toBe(secretHash("u@x.io"));
    expect(input(0)).not.toHaveProperty("SECRET_HASH");
  });
  it("maps a wrong code", async () => {
    sendMock.mockRejectedValueOnce(awsError("CodeMismatchException"));
    expect(await confirmForgotPassword("u@x.io", "000000", "Newpass1!")).toEqual({ ok: false, code: "code_mismatch" });
  });
});

describe("changePassword", () => {
  it("re-authenticates with the current password, then changes it", async () => {
    sendMock.mockResolvedValueOnce({ AuthenticationResult: { AccessToken: "tok" } }).mockResolvedValueOnce({});
    expect(await changePassword("u@x.io", "Oldpass1!", "Newpass1!")).toEqual({ ok: true });
    expect(calls()).toEqual(["InitiateAuth", "ChangePassword"]);
    expect(input(1)).toEqual({ AccessToken: "tok", PreviousPassword: "Oldpass1!", ProposedPassword: "Newpass1!" });
  });
  it("rejects a wrong current password without changing anything", async () => {
    sendMock.mockRejectedValueOnce(awsError("NotAuthorizedException"));
    expect(await changePassword("u@x.io", "wrong", "Newpass1!")).toEqual({ ok: false, code: "invalid_credentials" });
    expect(calls()).toEqual(["InitiateAuth"]);
  });
  it("reports a pending challenge (e.g. MFA) distinctly from a wrong password", async () => {
    sendMock.mockResolvedValueOnce({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s" });
    expect(await changePassword("u@x.io", "Right1!aa", "Newpass1!")).toEqual({ ok: false, code: "challenge_required" });
    expect(calls()).toEqual(["InitiateAuth"]);
  });
});

describe("password-request helpers", () => {
  it("normalizes email and rejects junk", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
    expect(normalizeEmail("no-at-sign")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });
  it("maps result codes to HTTP status", async () => {
    expect(toResponse({ ok: true }).status).toBe(200);
    expect(toResponse({ ok: false, code: "invalid_credentials" }).status).toBe(401);
    expect(toResponse({ ok: false, code: "too_many_attempts" }).status).toBe(429);
    expect(toResponse({ ok: false, code: "not_required" }).status).toBe(409);
    expect(await toResponse({ ok: false, code: "code_expired" }).json()).toEqual({ error: "code_expired" });
  });
});
