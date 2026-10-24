import { describe, it, expect, vi, beforeEach } from "vitest";

// DynamoDB/IAM clients are replaced by send spies; commands and exceptions stay real.
const { ddbSend, iamSend } = vi.hoisted(() => ({ ddbSend: vi.fn(), iamSend: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-dynamodb")>();
  return {
    ...actual,
    DynamoDBClient: function (this: { send: typeof ddbSend }) {
      this.send = ddbSend;
    },
  };
});
vi.mock("@aws-sdk/client-iam", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-iam")>();
  return {
    ...actual,
    IAMClient: function (this: { send: typeof iamSend }) {
      this.send = iamSend;
    },
  };
});

import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { NoSuchEntityException } from "@aws-sdk/client-iam";
import { kstMonthBucket, releaseTokenAxis } from "../budget-increase";
import { releaseTokenDeny, ROLE_UNRESOLVED_WARNING, TokenDenyDetachError } from "../token-deny";

const NOW = new Date("2026-10-24T12:00:00Z");
const ccf = () => new ConditionalCheckFailedException({ message: "cond", $metadata: {} });

type Input = {
  Key?: { SK?: { S?: string } };
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, { S?: string; N?: string }>;
};
const input = (cmd: unknown) => (cmd as { input: Input }).input;
const isDeny = (cmd: unknown) => input(cmd).Key?.SK?.S === "DENY#active";
const updates = () => ddbSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof UpdateItemCommand);
const deletes = () => ddbSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof DeleteItemCommand);

/** LIMIT#monthly row state + DENY#active row; the mock evaluates the two grant conditions. */
function table(opts: { limit?: { grant_bucket?: string } | null; deny?: Record<string, { S: string }> | null }) {
  const limit = opts.limit === undefined ? {} : opts.limit;
  ddbSend.mockImplementation(async (cmd: unknown) => {
    const i = input(cmd);
    if (cmd instanceof GetItemCommand) {
      if (isDeny(cmd)) return { Item: opts.deny ?? undefined };
      return { Item: limit ? { PK: { S: "x" } } : undefined };
    }
    if (cmd instanceof UpdateItemCommand) {
      if (!limit) throw ccf();
      const b = i.ExpressionAttributeValues?.[":b"]?.S;
      const same = limit.grant_bucket === b;
      if (i.UpdateExpression?.startsWith("ADD") !== same) throw ccf();
      return {};
    }
    return {};
  });
}

beforeEach(() => {
  ddbSend.mockReset();
  iamSend.mockReset();
});

describe("kstMonthBucket", () => {
  it("uses the KST month", () => {
    expect(kstMonthBucket(NOW)).toBe("2026-10");
    expect(kstMonthBucket(new Date("2026-10-31T15:00:00Z"))).toBe("2026-11");
    expect(kstMonthBucket(new Date("2026-10-31T14:59:59Z"))).toBe("2026-10");
  });
});

describe("releaseTokenDeny", () => {
  it("reports no row without writing", async () => {
    table({ deny: null });
    expect(await releaseTokenDeny("Dev@X.com")).toEqual({ released: false, found: false });
    expect(iamSend).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });
  it("detaches from the subdomain role and clears DENY#active", async () => {
    table({ deny: { PK: { S: "USER#dev@x.com" }, SK: { S: "DENY#active" }, subdomain: { S: "dev" } } });
    iamSend.mockResolvedValue({});
    expect(await releaseTokenDeny("dev@x.com")).toEqual({
      released: true,
      found: true,
      role: "cc-on-bedrock-local-user-dev",
      detached: true,
    });
    expect(iamSend.mock.calls[0][0].input).toEqual({
      RoleName: "cc-on-bedrock-local-user-dev",
      PolicyName: "cc-bedrock-local-token-deny",
    });
    expect(deletes()).toHaveLength(1);
  });
  it("treats an already-gone policy as detached=false but still clears", async () => {
    table({ deny: { subdomain: { S: "dev" } } });
    iamSend.mockRejectedValue(new NoSuchEntityException({ message: "gone", $metadata: {} }));
    const r = await releaseTokenDeny("dev@x.com");
    expect(r).toMatchObject({ released: true, detached: false });
    expect(deletes()).toHaveLength(1);
  });
  it("preserves DENY#active when the role cannot be resolved (207 path)", async () => {
    table({ deny: { PK: { S: "USER#dev@x.com" } } });
    expect(await releaseTokenDeny("dev@x.com")).toEqual({
      released: false,
      found: true,
      role: null,
      detached: false,
      warning: ROLE_UNRESOLVED_WARNING,
    });
    expect(iamSend).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });
  it("throws on a detach failure and keeps DENY#active", async () => {
    table({ deny: { subdomain: { S: "dev" } } });
    iamSend.mockRejectedValue(new Error("AccessDenied"));
    await expect(releaseTokenDeny("dev@x.com")).rejects.toThrow(TokenDenyDetachError);
    expect(deletes()).toHaveLength(0);
  });
});

describe("releaseTokenAxis", () => {
  it("ADDs to this KST month's grant", async () => {
    table({ limit: { grant_bucket: "2026-10" }, deny: null });
    expect(await releaseTokenAxis("Dev@X.com", 20, NOW)).toEqual({
      released: true,
      bucket: "2026-10",
      normalizedGranted: 1333340, // floor(20 × 66667)
      denyCleared: false,
    });
    const u = updates();
    expect(u).toHaveLength(1);
    expect(input(u[0]).UpdateExpression).toBe("ADD grant_normalized :n");
    expect(input(u[0]).ExpressionAttributeValues?.[":n"]).toEqual({ N: "1333340" });
  });
  it("replaces a past month's grant", async () => {
    table({ limit: { grant_bucket: "2026-09" }, deny: null });
    const r = await releaseTokenAxis("dev@x.com", 1.5, NOW);
    expect(r).toMatchObject({ released: true, normalizedGranted: 100000 }); // floor(1.5 × 66667)
    const last = updates().at(-1)!;
    expect(input(last).UpdateExpression).toBe("SET grant_bucket = :b, grant_normalized = :n");
    expect(input(last).ConditionExpression).toContain("attribute_exists(PK)");
  });
  it("starts a grant on a row without one", async () => {
    table({ limit: {}, deny: null });
    expect(await releaseTokenAxis("dev@x.com", 1, NOW)).toMatchObject({ released: true, normalizedGranted: 66667 });
  });
  it("writes nothing without a LIMIT#monthly row", async () => {
    table({ limit: null, deny: null });
    expect(await releaseTokenAxis("dev@x.com", 20, NOW)).toEqual({
      released: true,
      bucket: "2026-10",
      normalizedGranted: 0,
      denyCleared: false,
    });
  });
  it("releases an active deny after the grant", async () => {
    table({ limit: { grant_bucket: "2026-10" }, deny: { subdomain: { S: "dev" } } });
    iamSend.mockResolvedValue({});
    expect(await releaseTokenAxis("dev@x.com", 20, NOW)).toMatchObject({ released: true, denyCleared: true });
    const order = ddbSend.mock.calls.map((c) => c[0].constructor.name);
    expect(order.indexOf("UpdateItemCommand")).toBeLessThan(order.indexOf("DeleteItemCommand"));
  });
  it("surfaces the unresolved-role warning", async () => {
    table({ limit: { grant_bucket: "2026-10" }, deny: { PK: { S: "USER#dev@x.com" } } });
    expect(await releaseTokenAxis("dev@x.com", 20, NOW)).toMatchObject({
      released: false,
      warning: ROLE_UNRESOLVED_WARNING,
      normalizedGranted: 1333340,
      denyCleared: false,
    });
  });
  it("never throws: a DynamoDB failure is a warning", async () => {
    ddbSend.mockRejectedValue(new Error("Throttled"));
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r.released).toBe(false);
    expect(r.warning).toContain("Throttled");
  });
  it("a detach failure is a warning, grant kept", async () => {
    table({ limit: { grant_bucket: "2026-10" }, deny: { subdomain: { S: "dev" } } });
    iamSend.mockRejectedValue(new Error("AccessDenied"));
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r).toMatchObject({ released: false, normalizedGranted: 1333340 });
    expect(r.warning).toContain("AccessDenied");
  });
});
