import { describe, it, expect } from "vitest";
import { canApproveBudgetIncrease, canApproveRequest, exceedsDepartment } from "../approval-authz";

const admin = { isAdmin: true, groups: ["admin"], department: undefined, email: "a@x.com" };
const deptMgrEng = { isAdmin: false, groups: ["dept-manager"], department: "engineering", email: "m@x.com" };
const deptMgrNoDept = { isAdmin: false, groups: ["dept-manager"], department: undefined, email: "n@x.com" };
const plainUser = { isAdmin: false, groups: ["user"], department: "engineering", email: "p@x.com" };

describe("canApproveRequest — admin OR dept-manager(stored department)", () => {
  it("admin can approve any department", () => {
    expect(canApproveRequest(admin, "engineering", "req@x.com")).toBe(true);
    expect(canApproveRequest(admin, "research", "req@x.com")).toBe(true);
  });

  it("dept-manager can approve only their own department", () => {
    expect(canApproveRequest(deptMgrEng, "engineering", "req@x.com")).toBe(true);
    expect(canApproveRequest(deptMgrEng, "research", "req@x.com")).toBe(false);
  });

  it("dept-manager with no department cannot approve", () => {
    expect(canApproveRequest(deptMgrNoDept, "engineering", "req@x.com")).toBe(false);
  });

it("dept-manager denied when the request has no stored department (fail-closed)", () => {
    expect(canApproveRequest(deptMgrEng, "", "req@x.com")).toBe(false);
  });

  it("plain user cannot approve even in their department", () => {
    expect(canApproveRequest(plainUser, "engineering", "req@x.com")).toBe(false);
  });

  it("self-approval is case-insensitive and trims whitespace", () => {
    expect(canApproveRequest(admin, "engineering", "A@X.com")).toBe(false);
    expect(canApproveRequest(admin, "engineering", " a@x.com ")).toBe(false);
    expect(canApproveRequest(deptMgrEng, "engineering", "M@x.COM")).toBe(false);
  });
});

describe("canApproveBudgetIncrease", () => {
  const now = new Date("2026-10-24T05:00:00Z");
  const req = {
    email: "u@x.com",
    department: "engineering",
    period: "monthly" as const,
    periodKey: "2026-10",
    requesterIsDeptManager: false,
  };
  const dept = { monthlyBudget: 1000, monthSpend: 900, monthGranted: 50 };

  it("self-approval is case-insensitive", () => {
    expect(canApproveBudgetIncrease(admin, { ...req, email: "A@X.com" }, 10, dept, now)).toEqual({ ok: false, reason: "self" });
  });

  it("dept-manager within department budget is ok; over budget is exceeds_department; admin ok", () => {
    expect(canApproveBudgetIncrease(deptMgrEng, req, 50, dept, now)).toEqual({ ok: true });
    expect(canApproveBudgetIncrease(deptMgrEng, req, 51, dept, now)).toEqual({ ok: false, reason: "exceeds_department" });
    expect(canApproveBudgetIncrease(admin, req, 51, dept, now)).toEqual({ ok: true });
  });

  it("monthlyBudget 0 means no department limit", () => {
    expect(canApproveBudgetIncrease(deptMgrEng, req, 99999, { ...dept, monthlyBudget: 0 }, now)).toEqual({ ok: true });
  });

  it("dept-manager cannot approve another dept-manager's request; admin can", () => {
    const r = { ...req, requesterIsDeptManager: true };
    expect(canApproveBudgetIncrease(deptMgrEng, r, 10, dept, now)).toEqual({ ok: false, reason: "requester_is_manager" });
    expect(canApproveBudgetIncrease(admin, r, 10, dept, now)).toEqual({ ok: true });
  });

  it("other department and non-approver are rejected", () => {
    expect(canApproveBudgetIncrease(deptMgrEng, { ...req, department: "research" }, 10, dept, now)).toEqual({ ok: false, reason: "other_department" });
    expect(canApproveBudgetIncrease(plainUser, req, 10, dept, now)).toEqual({ ok: false, reason: "not_approver" });
  });

  it("canApproveBudgetIncrease expired: stale period key rejected even for admin", () => {
    const r = { ...req, period: "daily" as const, periodKey: "2026-10-23" };
    expect(canApproveBudgetIncrease(admin, r, 10, dept, now)).toEqual({ ok: false, reason: "expired" });
  });

  it("self is checked before expired", () => {
    const r = { ...req, email: "a@x.com", period: "daily" as const, periodKey: "2026-10-23" };
    expect(canApproveBudgetIncrease(admin, r, 10, dept, now)).toEqual({ ok: false, reason: "self" });
  });
});

describe("exceedsDepartment", () => {
  it("only when a limit is set and spend+granted+amount exceeds it", () => {
    expect(exceedsDepartment({ monthlyBudget: 100, monthSpend: 50, monthGranted: 40 }, 10)).toBe(false);
    expect(exceedsDepartment({ monthlyBudget: 100, monthSpend: 50, monthGranted: 40 }, 11)).toBe(true);
    expect(exceedsDepartment({ monthlyBudget: 0, monthSpend: 50, monthGranted: 40 }, 1e9)).toBe(false);
  });
});
