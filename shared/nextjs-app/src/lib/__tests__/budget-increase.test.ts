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
  decideBudgetAction,
  classifyCancellation,
  periodBaseCap,
  type BudgetIncreaseRecord,
  type StoredBudgetRequest,
} from "../budget-increase";
import type { ApproverUser } from "../approval-authz";

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

  it("omits department when there is none (GSI keys reject empty strings)", () => {
    const tx = buildCreateTransaction({
      ...REQ,
      department: "",
      subdomain: "dev",
      requesterRole: "user",
      requestedAmount: 20,
      reason: "x",
      snapshotSpend: 0,
      snapshotBudget: 50,
      requestedAt: NOW.toISOString(),
    });
    const req = tx.TransactItems![0].Put!;
    expect(req.Item).not.toHaveProperty("department");
    expect(buildCreateTransaction({ ...REQ, subdomain: "dev", requesterRole: "user", requestedAmount: 20, reason: "x",
      snapshotSpend: 0, snapshotBudget: 50, requestedAt: NOW.toISOString() }).TransactItems![0].Put!.Item?.department)
      .toEqual({ S: REQ.department });
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

describe("dept unlimitedPerUser overrides the last enforced cap", () => {
  const dept = { unlimitedPerUser: true, perUserDailyBudget: 10 };
  it("is uncapped even when effective*Budget predates the flag", () => {
    expect(periodIsCapped("daily", { effectiveDailyBudget: 50 }, dept)).toBe(false);
    expect(periodBaseCap("daily", { effectiveDailyBudget: 50 }, dept)).toBe(0);
  });
  it("a user's explicit cap still applies", () => {
    expect(periodIsCapped("daily", { dailyBudget: 5 }, dept)).toBe(true);
    expect(periodBaseCap("daily", { dailyBudget: 5 }, dept)).toBe(5);
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

describe("buildApproveTransaction department condition", () => {
  const dept = (tx: ReturnType<typeof buildApproveTransaction>) =>
    updates(tx).find((u) => "dept_id" in u.Key)!;

  it("is unconditional without deptCondition", () => {
    const u = dept(buildApproveTransaction(REQ, 20, "m@x.com", NOW));
    expect(u.ConditionExpression).toBeUndefined();
    expect(u.ExpressionAttributeValues?.[":zero"]).toBeUndefined();
  });
  it("requires the grant to still be absent when none was read", () => {
    const u = dept(buildApproveTransaction(REQ, 20, "m@x.com", NOW, { deptCondition: { seenGrant: null } }));
    expect(u.ConditionExpression).toBe("attribute_not_exists(#g) OR #g = :zero");
    expect(u.ExpressionAttributeValues?.[":zero"]).toEqual({ N: "0" });
    expect(u.ExpressionAttributeValues?.[":seen"]).toBeUndefined();
  });
  it("treats a read 0 like absent (still absent or still 0)", () => {
    const u = dept(buildApproveTransaction(REQ, 20, "m@x.com", NOW, { deptCondition: { seenGrant: "0" } }));
    expect(u.ConditionExpression).toBe("attribute_not_exists(#g) OR #g = :zero");
    expect(u.ExpressionAttributeValues?.[":zero"]).toEqual({ N: "0" });
  });
  it("requires the exact value read otherwise", () => {
    const u = dept(buildApproveTransaction(REQ, 20, "m@x.com", NOW, { deptCondition: { seenGrant: "35.5" } }));
    expect(u.ConditionExpression).toBe("#g = :seen");
    expect(u.ExpressionAttributeValues?.[":zero"]).toBeUndefined();
    expect(u.ExpressionAttributeNames?.["#g"]).toBe("grant#monthly#2026-10");
    expect(u.ExpressionAttributeValues?.[":seen"]).toEqual({ N: "35.5" });
  });
  it("a department-less request writes no department item", () => {
    const tx = buildApproveTransaction({ ...REQ, department: "" }, 20, "a@x.com", NOW);
    expect(updates(tx).some((u) => "dept_id" in u.Key)).toBe(false);
  });
});

describe("periodBaseCap", () => {
  it("prefers the mirror base", () => {
    expect(periodBaseCap("daily", { dailyBudget: 30, effectiveDailyBudget: 50 }, undefined)).toBe(30);
  });
  it("derives the base from the enforced cap minus the active grant", () => {
    expect(periodBaseCap("daily", { effectiveDailyBudget: 70, activeGrantDaily: 20 }, undefined)).toBe(50);
  });
  it("is 0 when uncapped", () => {
    expect(periodBaseCap("weekly", {}, {})).toBe(0);
  });
});

describe("decideBudgetAction", () => {
  const ADMIN: ApproverUser = { email: "admin@x.com", isAdmin: true, groups: ["admin"] };
  const MGR: ApproverUser = { email: "mgr@x.com", isAdmin: false, groups: ["dept-manager"], department: "eng" };
  const REQUEST: StoredBudgetRequest = {
    type: "budget_increase",
    email: "dev@x.com",
    department: "eng",
    status: "pending",
    period: "daily",
    periodKey: "2026-10-24",
    requestedAmount: 20,
  };
  const DEPT = { monthlyBudget: 1000, monthSpend: 900, monthGranted: 50 };
  const base = {
    approver: MGR,
    request: REQUEST,
    requesterRole: "user" as const,
    action: "approve" as const,
    dept: DEPT,
    seenDeptGrant: "50",
    baseCap: 50,
    now: NOW,
  };
  const deny = (status: number, error: string) => ({ kind: "deny", status, error });

  it("dept-manager approval carries the department condition", () => {
    expect(decideBudgetAction(base)).toEqual({ kind: "approve", amount: 20, deptCondition: { seenGrant: "50" } });
  });
  it("admin approval is unconditional and ignores the department cap", () => {
    expect(decideBudgetAction({ ...base, approver: ADMIN, amount: 500 })).toEqual({ kind: "approve", amount: 500 });
  });
  it("no department condition when the department has no cap", () => {
    expect(decideBudgetAction({ ...base, dept: { ...DEPT, monthlyBudget: 0 } })).toEqual({ kind: "approve", amount: 20 });
  });
  it("uses the approver-adjusted amount", () => {
    expect(decideBudgetAction({ ...base, amount: 10 })).toMatchObject({ kind: "approve", amount: 10 });
  });

  it("self wins over everything", () => {
    const self = { ...base, approver: { ...MGR, email: "DEV@x.com" }, request: { ...REQUEST, status: "approved" } };
    expect(decideBudgetAction(self)).toEqual(deny(403, "self"));
    expect(decideBudgetAction({ ...self, action: "reject" })).toEqual(deny(403, "self"));
  });
  it("dept-manager may decide only budget_increase", () => {
    for (const type of ["tier_change", "dlp_change", "iam_extension", "container_request"]) {
      const r = { ...base, request: { ...REQUEST, type } };
      expect(decideBudgetAction(r)).toEqual(deny(403, "admin_only_request_type"));
      expect(decideBudgetAction({ ...r, action: "reject" })).toEqual(deny(403, "admin_only_request_type"));
    }
  });
  it("dept-manager of another department, or a department-less request, is other_department", () => {
    expect(decideBudgetAction({ ...base, request: { ...REQUEST, department: "ops" } })).toEqual(deny(403, "other_department"));
    expect(decideBudgetAction({ ...base, request: { ...REQUEST, department: "" } })).toEqual(deny(403, "other_department"));
    expect(decideBudgetAction({ ...base, approver: { ...MGR, department: undefined } })).toEqual(deny(403, "other_department"));
  });
  it("admin may decide a department-less request", () => {
    const r = { ...base, approver: ADMIN, request: { ...REQUEST, department: "" } };
    expect(decideBudgetAction(r)).toEqual({ kind: "approve", amount: 20 });
  });
  it("manager or admin requester needs an admin, for approve AND reject", () => {
    for (const requesterRole of ["dept-manager", "admin"] as const) {
      expect(decideBudgetAction({ ...base, requesterRole })).toEqual(deny(403, "requester_is_manager"));
      expect(decideBudgetAction({ ...base, requesterRole, action: "reject" })).toEqual(deny(403, "requester_is_manager"));
      expect(decideBudgetAction({ ...base, requesterRole, approver: ADMIN })).toEqual({ kind: "approve", amount: 20 });
    }
  });
  it("requester_is_manager comes before the status check", () => {
    const r = { ...base, requesterRole: "dept-manager" as const, request: { ...REQUEST, status: "approved" } };
    expect(decideBudgetAction(r)).toEqual(deny(403, "requester_is_manager"));
  });
  it("a decided request is reported as already processed", () => {
    expect(decideBudgetAction({ ...base, request: { ...REQUEST, status: "rejected" } })).toEqual({
      kind: "already_processed",
      status: "rejected",
    });
  });
  it("an out-of-window request expires on approve and on reject, before amount checks", () => {
    const old = { ...base, request: { ...REQUEST, periodKey: "2026-10-23" }, amount: -1 };
    expect(decideBudgetAction(old)).toEqual({ kind: "expire" });
    expect(decideBudgetAction({ ...old, action: "reject" })).toEqual({ kind: "expire" });
  });
  it("reject skips amount and cap checks", () => {
    expect(decideBudgetAction({ ...base, action: "reject", amount: -1, baseCap: 0 })).toEqual({ kind: "reject" });
  });
  it("invalid amount, then unlimited period, then department cap", () => {
    expect(decideBudgetAction({ ...base, amount: 0, baseCap: 0 })).toEqual(deny(400, "invalid_amount"));
    expect(decideBudgetAction({ ...base, amount: 10001 })).toEqual(deny(400, "invalid_amount"));
    expect(decideBudgetAction({ ...base, amount: "5" })).toEqual(deny(400, "invalid_amount"));
    expect(decideBudgetAction({ ...base, amount: 51, baseCap: 0 })).toEqual(deny(409, "unlimited_period"));
    expect(decideBudgetAction({ ...base, approver: ADMIN, baseCap: 0 })).toEqual(deny(409, "unlimited_period"));
    expect(decideBudgetAction({ ...base, amount: 51 })).toEqual(deny(403, "exceeds_department"));
    expect(decideBudgetAction({ ...base, amount: 50 })).toMatchObject({ kind: "approve", amount: 50 });
  });
  it("a malformed stored period is a 400", () => {
    expect(decideBudgetAction({ ...base, request: { ...REQUEST, period: "yearly" } })).toEqual(deny(400, "malformed_request"));
  });
});

describe("classifyCancellation", () => {
  const tx = buildApproveTransaction(REQ, 20, "m@x.com", NOW, { deptCondition: { seenGrant: null } });
  const cancel = (codes: string[] | undefined) =>
    Object.assign(new Error("canceled"), {
      name: "TransactionCanceledException",
      CancellationReasons: codes?.map((Code) => ({ Code })),
    });

  it("is null for other errors", () => {
    expect(classifyCancellation(new Error("boom"), tx)).toBeNull();
  });
  it("maps a failed request condition", () => {
    expect(classifyCancellation(cancel(["ConditionalCheckFailed", "None", "None", "None"]), tx)).toEqual({
      failed: ["request"],
    });
  });
  it("maps a failed department condition", () => {
    expect(classifyCancellation(cancel(["None", "None", "None", "ConditionalCheckFailed"]), tx)).toEqual({
      failed: ["department"],
    });
  });
  it("maps a failed lock put on create", () => {
    const create = buildCreateTransaction({
      ...REQ, subdomain: "", requesterRole: "user", requestedAmount: 1, reason: "r",
      snapshotSpend: 0, snapshotBudget: 0, requestedAt: NOW.toISOString(),
    });
    expect(classifyCancellation(cancel(["None", "ConditionalCheckFailed"]), create)).toEqual({ failed: ["lock"] });
  });
  it("is retry for conflicts or missing reasons", () => {
    expect(classifyCancellation(cancel(["None", "TransactionConflict", "None", "None"]), tx)).toBe("retry");
    expect(classifyCancellation(cancel(["ConditionalCheckFailed", "TransactionConflict"]), tx)).toBe("retry");
    expect(classifyCancellation(cancel(undefined), tx)).toBe("retry");
  });
});
