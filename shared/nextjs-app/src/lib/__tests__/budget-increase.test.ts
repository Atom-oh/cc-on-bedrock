import { describe, it, expect } from "vitest";
import {
  buildApproveTransaction,
  buildRejectTransaction,
  buildExpireTransaction,
  buildCreateTransaction,
  lockKey,
  periodIsCapped,
  staleGrantAttrs,
  validateIncreaseInput,
  type BudgetIncreaseRecord,
} from "../budget-increase";

const NOW = new Date("2026-10-24T12:00:00Z");

const REQ: BudgetIncreaseRecord = {
  requestId: "r1",
  email: "dev@x.com",
  department: "eng",
  period: "daily",
  periodKey: "2026-10-24",
};

type Update = {
  TableName: string;
  Key: Record<string, { S: string }>;
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, { S?: string; N?: string }>;
};

function updates(tx: ReturnType<typeof buildApproveTransaction>): Update[] {
  return (tx.TransactItems ?? []).map((t) => t.Update).filter(Boolean) as unknown as Update[];
}

function addedAttrs(u: Update): string[] {
  const names = u.ExpressionAttributeNames ?? {};
  const add = u.UpdateExpression.match(/ADD (.*)$/)?.[1] ?? "";
  return add.split(",").map((s) => names[s.trim().split(" ")[0]]);
}

describe("lockKey", () => {
  it("is PENDING#{email}#{period}#{key} with a lowercased email", () => {
    expect(lockKey("Dev@X.com", "weekly", "2026-W43")).toBe("PENDING#dev@x.com#weekly#2026-W43");
  });
});

describe("buildApproveTransaction", () => {
  it("cascades a daily grant to daily, weekly and monthly; dept gets the monthly grant once", () => {
    const tx = buildApproveTransaction(REQ, 20, "mgr@x.com", NOW);
    const [reqUpd, userUpd, deptUpd] = updates(tx);
    expect(userUpd.Key).toEqual({ user_id: { S: "dev@x.com" } });
    expect(addedAttrs(userUpd)).toEqual([
      "grant#daily#2026-10-24",
      "grant#weekly#2026-W43",
      "grant#monthly#2026-10",
    ]);
    expect(userUpd.ExpressionAttributeValues?.[":amt"]).toEqual({ N: "20" });
    expect(deptUpd.Key).toEqual({ dept_id: { S: "eng" } });
    expect(addedAttrs(deptUpd)).toEqual(["grant#monthly#2026-10"]);
    expect(deptUpd.ExpressionAttributeValues?.[":amt"]).toEqual({ N: "20" });
    expect(reqUpd.Key).toEqual({ PK: { S: "REQUEST#r1" }, SK: { S: "META" } });
  });

  it("has four items: request update, lock delete, user ADD, dept ADD", () => {
    const tx = buildApproveTransaction(REQ, 20, "mgr@x.com", NOW);
    expect(tx.TransactItems).toHaveLength(4);
    const del = tx.TransactItems?.find((t) => t.Delete)?.Delete;
    expect(del?.Key).toEqual({ PK: { S: "PENDING#dev@x.com#daily#2026-10-24" }, SK: { S: "META" } });
  });

  it("omits skipped periods from the user grants", () => {
    const tx = buildApproveTransaction(REQ, 20, "mgr@x.com", NOW, { skipPeriods: ["weekly"] });
    const userUpd = updates(tx)[1];
    expect(addedAttrs(userUpd)).toEqual(["grant#daily#2026-10-24", "grant#monthly#2026-10"]);
  });

  it("drops the user update entirely when every period is skipped", () => {
    const tx = buildApproveTransaction(REQ, 20, "mgr@x.com", NOW, {
      skipPeriods: ["daily", "weekly", "monthly"],
    });
    expect(updates(tx).some((u) => "user_id" in u.Key)).toBe(false);
    expect(tx.TransactItems).toHaveLength(3);
  });

  it("a monthly request grants only the monthly window", () => {
    const tx = buildApproveTransaction({ ...REQ, period: "monthly", periodKey: "2026-10" }, 5, "m@x.com", NOW);
    expect(addedAttrs(updates(tx)[1])).toEqual(["grant#monthly#2026-10"]);
  });

  it("marks the request approved only while it is still pending", () => {
    const reqUpd = updates(buildApproveTransaction(REQ, 20, "mgr@x.com", NOW))[0];
    expect(reqUpd.ConditionExpression).toBe("#s = :pending");
    expect(reqUpd.ExpressionAttributeNames?.["#s"]).toBe("status");
    expect(reqUpd.ExpressionAttributeValues?.[":pending"]).toEqual({ S: "pending" });
    expect(reqUpd.ExpressionAttributeValues?.[":status"]).toEqual({ S: "approved" });
    expect(reqUpd.ExpressionAttributeValues?.[":by"]).toEqual({ S: "mgr@x.com" });
    expect(reqUpd.ExpressionAttributeValues?.[":amt"]).toEqual({ N: "20" });
    expect(reqUpd.UpdateExpression).toContain("approvedAmount = :amt");
    expect(reqUpd.UpdateExpression).toContain("approvedAt = :at");
  });
});

describe("buildRejectTransaction / buildExpireTransaction", () => {
  it("reject is conditional on pending and deletes the lock", () => {
    const tx = buildRejectTransaction(REQ, "mgr@x.com", "not needed", NOW);
    expect(tx.TransactItems).toHaveLength(2);
    const upd = tx.TransactItems?.[0].Update;
    expect(upd?.ConditionExpression).toBe("#s = :pending");
    expect(upd?.ExpressionAttributeValues?.[":status"]).toEqual({ S: "rejected" });
    expect(upd?.ExpressionAttributeValues?.[":reason"]).toEqual({ S: "not needed" });
    expect(tx.TransactItems?.[1].Delete?.Key).toEqual({
      PK: { S: "PENDING#dev@x.com#daily#2026-10-24" },
      SK: { S: "META" },
    });
  });

  it("reject without a reason does not write rejectReason", () => {
    const upd = buildRejectTransaction(REQ, "mgr@x.com", "", NOW).TransactItems?.[0].Update;
    expect(upd?.UpdateExpression).not.toContain("rejectReason");
    expect(upd?.ExpressionAttributeValues?.[":reason"]).toBeUndefined();
  });

  it("expire is conditional on pending and deletes the lock", () => {
    const tx = buildExpireTransaction(REQ, NOW);
    const upd = tx.TransactItems?.[0].Update;
    expect(upd?.ConditionExpression).toBe("#s = :pending");
    expect(upd?.ExpressionAttributeValues?.[":status"]).toEqual({ S: "expired" });
    expect(tx.TransactItems?.[1].Delete).toBeDefined();
  });
});

describe("buildCreateTransaction", () => {
  it("puts the request and the lock, both only if absent", () => {
    const tx = buildCreateTransaction({
      ...REQ,
      subdomain: "dev",
      requesterRole: "user",
      requestedAmount: 20,
      reason: "release week",
      snapshotSpend: 49.5,
      snapshotBudget: 50,
      requestedAt: NOW.toISOString(),
    });
    const [req, lock] = (tx.TransactItems ?? []).map((t) => t.Put!);
    expect(req.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(req.Item?.PK).toEqual({ S: "REQUEST#r1" });
    expect(req.Item?.type).toEqual({ S: "budget_increase" });
    expect(req.Item?.status).toEqual({ S: "pending" });
    expect(req.Item?.requestedAmount).toEqual({ N: "20" });
    expect(lock.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(lock.Item?.PK).toEqual({ S: "PENDING#dev@x.com#daily#2026-10-24" });
    expect(lock.Item?.requestId).toEqual({ S: "r1" });
    // The lock must not look like a user's request to email-filtered scans.
    expect(lock.Item?.email).toBeUndefined();
  });
});

describe("validateIncreaseInput", () => {
  const ok = { period: "weekly", requestedAmount: 20, reason: "x" };
  it("accepts a valid body", () => {
    expect(validateIncreaseInput(ok)).toEqual({ ok: true, period: "weekly", requestedAmount: 20, reason: "x" });
  });
  it.each([
    [{ ...ok, period: "yearly" }, "invalid_period"],
    [{ ...ok, period: undefined }, "invalid_period"],
    [{ ...ok, requestedAmount: 0 }, "invalid_amount"],
    [{ ...ok, requestedAmount: 10000.01 }, "invalid_amount"],
    [{ ...ok, requestedAmount: "20" }, "invalid_amount"],
    [{ ...ok, requestedAmount: Number.NaN }, "invalid_amount"],
    [{ ...ok, reason: "" }, "invalid_reason"],
    [{ ...ok, reason: "   " }, "invalid_reason"],
    [{ ...ok, reason: "a".repeat(501) }, "invalid_reason"],
  ])("rejects %j as %s", (body, error) => {
    expect(validateIncreaseInput(body as Record<string, unknown>)).toEqual({ ok: false, error });
  });
  it("accepts exactly 10000 and a 500-char reason", () => {
    expect(validateIncreaseInput({ ...ok, requestedAmount: 10000, reason: "a".repeat(500) }).ok).toBe(true);
  });
});

describe("periodIsCapped", () => {
  it("uses the user explicit cap", () => {
    expect(periodIsCapped("weekly", { weeklyBudget: 100 }, undefined)).toBe(true);
  });
  it("uses the dept per-user default", () => {
    expect(periodIsCapped("daily", {}, { perUserDailyBudget: 10 })).toBe(true);
  });
  it("falls back to the cap budget-check last enforced (global env default)", () => {
    expect(periodIsCapped("daily", { effectiveDailyBudget: 50 }, undefined)).toBe(true);
  });
  it("is uncapped when nothing resolves", () => {
    expect(periodIsCapped("monthly", { effectiveMonthlyBudget: 0 }, {})).toBe(false);
    expect(periodIsCapped("monthly", undefined, undefined)).toBe(false);
  });
});

describe("staleGrantAttrs", () => {
  it("returns grant attributes outside the current windows only", () => {
    const row = {
      user_id: "dev@x.com",
      "grant#daily#2026-10-23": 5,
      "grant#daily#2026-10-24": 5,
      "grant#weekly#2026-W42": 5,
      "grant#weekly#2026-W43": 5,
      "grant#monthly#2026-09": 5,
      "grant#monthly#2026-10": 5,
      "grant#bogus#x": 1,
      dailyBudget: 50,
    };
    expect(staleGrantAttrs(row, NOW).sort()).toEqual(
      ["grant#bogus#x", "grant#daily#2026-10-23", "grant#monthly#2026-09", "grant#weekly#2026-W42"].sort(),
    );
  });
});
