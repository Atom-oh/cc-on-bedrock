import { afterEach, describe, it, expect, vi } from "vitest";
import { applyIamGrant, removeIamGrant, resolveAwsAccountId } from "../ec2-clients";
import type { IamStatement } from "../iam-request-validation";

const STMTS: IamStatement[] = [
  { Action: ["sqs:SendMessage"], Resource: ["arn:aws:sqs:ap-northeast-2:180294183052:my-queue"] },
];
const OPTS = { subdomain: "alice", sub: "uuid-1", requestId: "req-1", statements: STMTS, accountId: "180294183052", region: "ap-northeast-2" };
const ORIGINAL_AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;

afterEach(() => {
  if (ORIGINAL_AWS_ACCOUNT_ID === undefined) {
    delete process.env.AWS_ACCOUNT_ID;
  } else {
    process.env.AWS_ACCOUNT_ID = ORIGINAL_AWS_ACCOUNT_ID;
  }
  vi.unstubAllGlobals();
});

function noSuchEntity() {
  return Object.assign(new Error("not found"), { name: "NoSuchEntityException" });
}
function cmdName(c: unknown): string {
  return (c as { constructor: { name: string } }).constructor.name;
}
function roleOf(c: unknown): string {
  return (c as { input: { RoleName: string } }).input.RoleName;
}

describe("applyIamGrant — both roles, fail-loud, rollback", () => {
  it("attaches to both task and local roles", async () => {
    const iam = { send: vi.fn().mockResolvedValue({}) };
    const r = await applyIamGrant({ ...OPTS, iam: iam as never });
    expect(r.attached).toEqual(["cc-on-bedrock-task-alice", "cc-on-bedrock-local-user-uuid-1"]);
    expect(iam.send).toHaveBeenCalledTimes(2);
  });

  it("skips a role that does not exist (NoSuchEntity)", async () => {
    const iam = { send: vi.fn().mockImplementation((c) => (roleOf(c).startsWith("cc-on-bedrock-local-user-") ? Promise.reject(noSuchEntity()) : Promise.resolve({}))) };
    const r = await applyIamGrant({ ...OPTS, iam: iam as never });
    expect(r.attached).toEqual(["cc-on-bedrock-task-alice"]);
  });

  it("rolls back the attached role and throws when an expected role attach fails", async () => {
    const iam = {
      send: vi.fn().mockImplementation((c) => {
        if (cmdName(c) === "PutRolePolicyCommand" && roleOf(c).startsWith("cc-on-bedrock-local-user-")) {
          return Promise.reject(Object.assign(new Error("AccessDenied"), { name: "AccessDeniedException" }));
        }
        return Promise.resolve({});
      }),
    };
    await expect(applyIamGrant({ ...OPTS, iam: iam as never })).rejects.toThrow();
    // compensating remove on the task role that succeeded
    const deletes = iam.send.mock.calls.map((a) => a[0]).filter((c) => cmdName(c) === "DeleteRolePolicyCommand");
    expect(deletes.map(roleOf)).toContain("cc-on-bedrock-task-alice");
  });

  it("throws before any attach when statements fail re-validation", async () => {
    const iam = { send: vi.fn() };
    await expect(
      applyIamGrant({ ...OPTS, statements: [{ Action: ["sqs:SendMessage"], Resource: ["*"] }], iam: iam as never }),
    ).rejects.toThrow(/valid/i);
    expect(iam.send).not.toHaveBeenCalled();
  });

it("throws when accountId is unavailable (fail-closed, symmetric with request path)", async () => {
    const prev = process.env.AWS_ACCOUNT_ID; delete process.env.AWS_ACCOUNT_ID;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("IMDS unavailable")));
    const iam = { send: vi.fn() };
    await expect(applyIamGrant({ ...OPTS, accountId: undefined, iam: iam as never })).rejects.toThrow(/AWS_ACCOUNT_ID/);
    expect(iam.send).not.toHaveBeenCalled();
    if (prev) process.env.AWS_ACCOUNT_ID = prev;
  });

  it("throws when both subdomain and sub are empty (no target role)", async () => {
    const iam = { send: vi.fn() };
    await expect(applyIamGrant({ ...OPTS, subdomain: "", sub: "", iam: iam as never })).rejects.toThrow(/no target role/i);
    expect(iam.send).not.toHaveBeenCalled();
  });
});

describe("removeIamGrant", () => {
  it("deletes from both roles; missing policy is OK", async () => {
    const iam = { send: vi.fn().mockImplementation((c) => (roleOf(c).startsWith("cc-on-bedrock-local-user-") ? Promise.reject(noSuchEntity()) : Promise.resolve({}))) };
    await expect(removeIamGrant({ subdomain: "alice", sub: "uuid-1", requestId: "req-1", iam: iam as never })).resolves.not.toThrow();
    expect(iam.send).toHaveBeenCalledTimes(2);
  });
});

describe("resolveAwsAccountId", () => {
  it("uses AWS_ACCOUNT_ID without calling IMDS", async () => {
    process.env.AWS_ACCOUNT_ID = "180294183052";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(resolveAwsAccountId()).resolves.toBe("180294183052");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves account id from EC2 IMDS when AWS_ACCOUNT_ID is missing", async () => {
    delete process.env.AWS_ACCOUNT_ID;
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "imds-token" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accountId: "180294183052" }) });
    vi.stubGlobal("fetch", fetch);

    await expect(resolveAwsAccountId()).resolves.toBe("180294183052");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when neither AWS_ACCOUNT_ID nor IMDS account id is available", async () => {
    delete process.env.AWS_ACCOUNT_ID;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("IMDS unavailable")));

    await expect(resolveAwsAccountId()).rejects.toThrow(/AWS_ACCOUNT_ID.*IMDS/i);
  });
});
