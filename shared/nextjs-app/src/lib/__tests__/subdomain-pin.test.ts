import { describe, it, expect, vi } from "vitest";
import { AdminGetUserCommand, AdminUpdateUserAttributesCommand } from "@aws-sdk/client-cognito-identity-provider";
import { deriveSubdomain } from "../utils";
import { pinnedSubdomain } from "../role-admin";

describe("deriveSubdomain (mirror of role_factory.derive_subdomain)", () => {
  // Expected values come from running lambda/role_factory.py derive_subdomain.
  it.each([
    ["psungbum@example.com", "psungbum"],
    ["John.Doe@x.com", "john-doe"],
    ["a_b+c@x.com", "a-b-c"],
    ["--x..y--@x.com", "x-y"],
    ["ab@x.com", null],
    [`${"A".repeat(40)}@x.com`, "a".repeat(30)],
    [`${"x".repeat(29)}.y@x.com`, "x".repeat(29)],
  ])("%s → %s", (email, expected) => {
    expect(deriveSubdomain(email)).toBe(expected);
  });
});

describe("pinnedSubdomain (ADR-016 shared pool)", () => {
  const user = (attrs: Record<string, string>) => ({
    UserAttributes: Object.entries(attrs).map(([Name, Value]) => ({ Name, Value })),
  });

  it("returns an existing pin without writing", async () => {
    const send = vi.fn(async (_c: unknown) => user({ email: "new@x.com", email_verified: "true", "custom:subdomain": "old-name" }));
    await expect(pinnedSubdomain("u@x.com", send)).resolves.toBe("old-name");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(AdminGetUserCommand);
  });

  it("pins from the current email on first use", async () => {
    const send = vi.fn(async (c: unknown) => (c instanceof AdminGetUserCommand ? user({ email: "Jane.Kim@x.com", email_verified: "true" }) : {}));
    await expect(pinnedSubdomain("jane.kim@x.com", send)).resolves.toBe("jane-kim");
    const write = send.mock.calls[1][0] as AdminUpdateUserAttributesCommand;
    expect(write).toBeInstanceOf(AdminUpdateUserAttributesCommand);
    expect(write.input.UserAttributes).toEqual([{ Name: "custom:subdomain", Value: "jane-kim" }]);
  });

  it("refuses an unverified email even when a pin exists", async () => {
    const send = vi.fn(async (_c: unknown) => user({ email: "victim@x.com", email_verified: "false", "custom:subdomain": "mallory" }));
    await expect(pinnedSubdomain("u@x.com", send)).rejects.toThrow(/not verified/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses to pin from an unverified email", async () => {
    const send = vi.fn(async (_c: unknown) => user({ email: "victim@x.com", email_verified: "false" }));
    await expect(pinnedSubdomain("u@x.com", send)).rejects.toThrow(/not verified/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("throws (fail closed) when no valid subdomain can be derived", async () => {
    const send = vi.fn(async (_c: unknown) => user({ email: "ab@x.com", email_verified: "true" }));
    await expect(pinnedSubdomain("ab@x.com", send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
