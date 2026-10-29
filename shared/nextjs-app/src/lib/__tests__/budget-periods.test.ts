import { describe, it, expect } from "vitest";
import { resolvePeriodBudget, exceededPeriods } from "../budget-periods";

describe("resolvePeriodBudget (mirrors budget-check _effective_user_limits)", () => {
  const user = { dailyBudget: 50, weeklyBudget: 0, monthlyBudget: 200 };
  const dept = { perUserWeeklyBudget: 100, perUserDailyBudget: 30 };
  it("resolves each period independently", () => {
    expect(resolvePeriodBudget("daily", user, dept)).toEqual({ value: 50, source: "user", base: 50, grant: 0 });
    expect(resolvePeriodBudget("weekly", user, dept)).toEqual({ value: 100, source: "dept", base: 100, grant: 0 });
    expect(resolvePeriodBudget("monthly", user, dept)).toEqual({ value: 200, source: "user", base: 200, grant: 0 });
  });
  it("falls back to globals, then no cap", () => {
    expect(resolvePeriodBudget("daily", undefined, undefined, { daily: 50 })).toEqual({ value: 50, source: "global", base: 50, grant: 0 });
    expect(resolvePeriodBudget("weekly", undefined, undefined, { daily: 50 })).toEqual({ value: 0, source: "none", base: 0, grant: 0 });
  });
});

describe("resolvePeriodBudget grants", () => {
  it("adds the grant only to a capped period", () => {
    expect(resolvePeriodBudget("daily", { dailyBudget: 50 }, undefined, {}, 20)).toEqual({ value: 70, source: "user", base: 50, grant: 20 });
    expect(resolvePeriodBudget("weekly", {}, undefined, {}, 20).value).toBe(0);
  });
});

describe("exceededPeriods", () => {
  it("any period at or over its cap counts; 0 = no cap", () => {
    expect(exceededPeriods({ daily: 10, weekly: 100, monthly: 120 }, { daily: 50, weekly: 100, monthly: 200 })).toEqual(["weekly"]);
    expect(exceededPeriods({ daily: 999 }, { daily: 0 })).toEqual([]);
  });
});

describe("resolvePeriodBudget dept unlimitedPerUser (ADR-008 amendment)", () => {
  const dept = { unlimitedPerUser: true, perUserDailyBudget: 30, perUserMonthlyBudget: 200 };
  it("a user's explicit cap still wins", () => {
    expect(resolvePeriodBudget("daily", { dailyBudget: 50 }, dept, { daily: 10 })).toEqual({ value: 50, source: "user", base: 50, grant: 0 });
  });
  it("beats the dept per-user default and the global default (no cap, no fallthrough)", () => {
    expect(resolvePeriodBudget("daily", {}, dept, { daily: 10 })).toEqual({ value: 0, source: "dept-unlimited", base: 0, grant: 0 });
    expect(resolvePeriodBudget("weekly", undefined, dept, { weekly: 10 })).toEqual({ value: 0, source: "dept-unlimited", base: 0, grant: 0 });
  });
  it("no grant is added to the uncapped period", () => {
    expect(resolvePeriodBudget("monthly", {}, dept, {}, 20).value).toBe(0);
  });
  it("flag absent or false keeps the existing resolution", () => {
    const { unlimitedPerUser: _, ...plain } = dept;
    for (const d of [plain, { ...plain, unlimitedPerUser: false }]) {
      expect(resolvePeriodBudget("daily", {}, d, { daily: 10 })).toEqual({ value: 30, source: "dept", base: 30, grant: 0 });
      expect(resolvePeriodBudget("weekly", {}, d, { weekly: 10 })).toEqual({ value: 10, source: "global", base: 10, grant: 0 });
    }
  });
});
