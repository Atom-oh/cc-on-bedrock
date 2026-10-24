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

/**
 * Table state: LIMIT#monthly row (null = absent), DENY#active row, this month's
 * counter. The mock evaluates the two grant conditions and returns ALL_NEW.
 */
function table(opts: {
  limit?: { grant_bucket?: string; grant_normalized?: number; max_normalized?: number } | null;
  deny?: Record<string, { S: string }> | null;
  counter?: number;
}) {
  const limit = opts.limit === undefined ? { max_normalized: 1000 } : opts.limit;
  ddbSend.mockImplementation(async (cmd: unknown) => {
    const i = input(cmd);
    if (cmd instanceof GetItemCommand) {
      if (isDeny(cmd)) return { Item: opts.deny ?? undefined };
      if (i.Key?.SK?.S?.startsWith("COUNTER#")) {
        return { Item: opts.counter === undefined ? undefined : { normalized: { N: String(opts.counter) } } };
      }
      return { Item: limit ? { PK: { S: "x" } } : undefined };
    }
    if (cmd instanceof UpdateItemCommand) {
      if (!limit) throw ccf();
      const b = i.ExpressionAttributeValues?.[":b"]?.S;
      const n = Number(i.ExpressionAttributeValues?.[":n"]?.N);
      const add = i.UpdateExpression?.startsWith("ADD") ?? false;
      if (add !== (limit.grant_bucket === b)) throw ccf();
      limit.grant_normalized = add ? (limit.grant_normalized ?? 0) + n : n;
      limit.grant_bucket = b;
      const attrs: Record<string, { S?: string; N?: string }> = {
        grant_bucket: { S: b! },
        grant_normalized: { N: String(limit.grant_normalized) },
      };
      if (limit.max_normalized !== undefined) attrs.max_normalized = { N: String(limit.max_normalized) };
      return { Attributes: attrs };
    }
    return {};
  });
}

const userMonthlyDeny = { subdomain: { S: "dev" }, scope: { S: "user" }, period: { S: "monthly" } };

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
  it("ADDs to this KST month's grant (no deny → released)", async () => {
    table({ limit: { grant_bucket: "2026-10", grant_normalized: 5, max_normalized: 1000 }, deny: null });
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
    table({ limit: { grant_bucket: "2026-09", max_normalized: 1000 }, deny: null });
    const r = await releaseTokenAxis("dev@x.com", 1.5, NOW);
    expect(r).toMatchObject({ released: true, normalizedGranted: 100000 }); // floor(1.5 × 66667)
    const last = updates().at(-1)!;
    expect(input(last).UpdateExpression).toBe("SET grant_bucket = :b, grant_normalized = :n");
    expect(input(last).ConditionExpression).toContain("attribute_exists(PK)");
  });
  it("no LIMIT#monthly row and no deny: nothing written, noTokenLimit", async () => {
    table({ limit: null, deny: null });
    expect(await releaseTokenAxis("dev@x.com", 20, NOW)).toEqual({
      released: true,
      bucket: "2026-10",
      normalizedGranted: 0,
      noTokenLimit: true,
      denyCleared: false,
    });
  });
  it("releases a user-monthly deny once the counter is below the new cap", async () => {
    table({ limit: { max_normalized: 1000 }, deny: userMonthlyDeny, counter: 1200 });
    iamSend.mockResolvedValue({});
    expect(await releaseTokenAxis("dev@x.com", 1, NOW)).toEqual({
      released: true,
      bucket: "2026-10",
      normalizedGranted: 66667,
      denyCleared: true,
    });
    expect(deletes()).toHaveLength(1);
    const order = ddbSend.mock.calls.map((c) => c[0].constructor.name);
    expect(order.indexOf("UpdateItemCommand")).toBeLessThan(order.indexOf("DeleteItemCommand"));
  });
  it("keeps a user-monthly deny the grant does not cure", async () => {
    table({ limit: { max_normalized: 1000 }, deny: userMonthlyDeny, counter: 67667 }); // = 1000 + 66667
    const r = await releaseTokenAxis("dev@x.com", 1, NOW);
    expect(r).toMatchObject({ released: false, reason: "still_over_cap", denyCleared: false, normalizedGranted: 66667 });
    expect(r.warning).toBe("token deny from insufficient grant cap — not lifted by a personal grant");
    expect(iamSend).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });
  it("keeps a dept-scope deny", async () => {
    table({ deny: { ...userMonthlyDeny, scope: { S: "dept" } }, counter: 0 });
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r).toMatchObject({ released: false, reason: "dept_scope", denyCleared: false, normalizedGranted: 1333340 });
    expect(r.warning).toBe("token deny from dept cap — not lifted by a personal grant");
    expect(deletes()).toHaveLength(0);
  });
  it("keeps a daily-period deny", async () => {
    table({ deny: { ...userMonthlyDeny, period: { S: "daily" } }, counter: 0 });
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r).toMatchObject({ released: false, reason: "non_monthly" });
    expect(r.warning).toBe("token deny from daily cap — not lifted by a personal grant");
    expect(deletes()).toHaveLength(0);
  });
  it("keeps a legacy deny without scope", async () => {
    table({ deny: { subdomain: { S: "dev" }, period: { S: "monthly" } }, counter: 0 });
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r).toMatchObject({ released: false, reason: "legacy_deny" });
    expect(r.warning).toBe("token deny from legacy cap — not lifted by a personal grant");
    expect(deletes()).toHaveLength(0);
  });
  it("keeps a user-monthly deny when there is no LIMIT#monthly row", async () => {
    table({ limit: null, deny: userMonthlyDeny, counter: 0 });
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r).toMatchObject({ released: false, reason: "no_token_limit", noTokenLimit: true, normalizedGranted: 0 });
    expect(updates().length).toBeGreaterThan(0); // attempted, condition failed: nothing written
    expect(deletes()).toHaveLength(0);
  });
  it("surfaces the unresolved-role warning", async () => {
    table({ deny: { scope: { S: "user" }, period: { S: "monthly" } }, counter: 0 });
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r).toMatchObject({ released: false, warning: ROLE_UNRESOLVED_WARNING, denyCleared: false });
  });
  it("never throws: a DynamoDB failure is a warning", async () => {
    ddbSend.mockRejectedValue(new Error("Throttled"));
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r.released).toBe(false);
    expect(r.warning).toContain("Throttled");
  });
  it("a detach failure is a warning, grant kept", async () => {
    table({ deny: userMonthlyDeny, counter: 0 });
    iamSend.mockRejectedValue(new Error("AccessDenied"));
    const r = await releaseTokenAxis("dev@x.com", 20, NOW);
    expect(r).toMatchObject({ released: false, normalizedGranted: 1333340 });
    expect(r.warning).toContain("AccessDenied");
  });
});
