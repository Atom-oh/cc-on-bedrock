import { describe, it, expect } from "vitest";
import { canSetMemberLimit, validateMemberLimits, MAX_STANDING_LIMIT_USD } from "../dept-limit-authz";

const mgr = { email: "m@x.com", role: "dept-manager" as const, department: "engineering" };
const admin = { email: "a@x.com", role: "admin" as const, department: undefined };
const member = { email: "u@x.com", department: "engineering", role: "user" as const };

describe("canSetMemberLimit", () => {
  it("dept-manager cannot change their own limits", () => {
    expect(
      canSetMemberLimit({ actor: mgr, target: { email: "M@X.com", department: "engineering" }, deptMonthlyBudget: 0 })
    ).toEqual({ ok: false, error: "self" });
  });

  it("dept-manager cannot change a member of another department", () => {
    expect(
      canSetMemberLimit({ actor: mgr, target: { email: "u@x.com", department: "research" }, deptMonthlyBudget: 0 })
    ).toEqual({ ok: false, error: "other_department" });
  });

  it("dept-manager without a real department matches nobody (fail-closed)", () => {
    for (const department of [undefined, "", "default"]) {
      expect(
        canSetMemberLimit({ actor: { ...mgr, department }, target: { email: "u@x.com", department: "default" }, deptMonthlyBudget: 0 })
      ).toEqual({ ok: false, error: "other_department" });
    }
  });

  it("monthly limit above a set department total is refused", () => {
    expect(
      canSetMemberLimit({ actor: mgr, target: member, monthlyBudget: 1200, deptMonthlyBudget: 1000 })
    ).toEqual({ ok: false, error: "exceeds_department_total" });
    expect(canSetMemberLimit({ actor: mgr, target: member, monthlyBudget: 1000, deptMonthlyBudget: 1000 })).toEqual({ ok: true });
  });

  it("no department total (0) means no cap on the member monthly limit", () => {
    expect(canSetMemberLimit({ actor: mgr, target: member, monthlyBudget: 1200, deptMonthlyBudget: 0 })).toEqual({ ok: true });
  });

  it("daily/weekly-only change is not checked against the department total", () => {
    expect(canSetMemberLimit({ actor: mgr, target: member, deptMonthlyBudget: 10 })).toEqual({ ok: true });
  });

  it("dept-manager may not set limits for another manager or an admin", () => {
    for (const role of ["dept-manager", "admin"] as const) {
      expect(canSetMemberLimit({ actor: mgr, target: { ...member, role }, deptMonthlyBudget: 0 })).toEqual({
        ok: false,
        error: "target_is_manager",
      });
    }
  });

  it("dept-manager with an unknown target role is denied (fail-closed)", () => {
    expect(
      canSetMemberLimit({ actor: mgr, target: { email: "u@x.com", department: "engineering" }, deptMonthlyBudget: 0 })
    ).toEqual({ ok: false, error: "target_is_manager" });
  });

  it("plain user is not a manager", () => {
    expect(
      canSetMemberLimit({ actor: { email: "p@x.com", role: "user", department: "engineering" }, target: member, deptMonthlyBudget: 0 })
    ).toEqual({ ok: false, error: "not_manager" });
  });

  it("admin may change anyone, self and managers included", () => {
    for (const role of ["dept-manager", "admin", undefined] as const) {
      expect(canSetMemberLimit({ actor: admin, target: { ...member, role }, deptMonthlyBudget: 0 })).toEqual({ ok: true });
    }
    expect(canSetMemberLimit({ actor: admin, target: { email: "a@x.com", department: "default" }, deptMonthlyBudget: 0 })).toEqual({ ok: true });
    expect(
      canSetMemberLimit({ actor: admin, target: { email: "u@x.com", department: "research" }, monthlyBudget: 5000, deptMonthlyBudget: 1000 })
    ).toEqual({ ok: true });
  });
});

describe("validateMemberLimits", () => {
  it("accepts any subset of periods with finite values in range (0 = inherit)", () => {
    expect(validateMemberLimits({ dailyBudget: 0, monthlyBudget: 50 })).toEqual({
      ok: true,
      limits: { dailyBudget: 0, monthlyBudget: 50 },
    });
    expect(validateMemberLimits({ weeklyBudget: MAX_STANDING_LIMIT_USD })).toEqual({
      ok: true,
      limits: { weeklyBudget: MAX_STANDING_LIMIT_USD },
    });
  });

  it("rejects negatives, NaN, Infinity, non-numbers and values above the bound", () => {
    for (const v of [-1, NaN, Infinity, "10", null, MAX_STANDING_LIMIT_USD + 1]) {
      expect(validateMemberLimits({ dailyBudget: v })).toEqual({ ok: false, error: "invalid_limit" });
    }
  });

  it("requires at least one period", () => {
    expect(validateMemberLimits({})).toEqual({ ok: false, error: "limit_required" });
  });
});
