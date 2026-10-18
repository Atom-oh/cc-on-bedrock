import { describe, it, expect } from "vitest";
import { resolvePeriodBudget, exceededPeriods } from "../budget-periods";

describe("resolvePeriodBudget (mirrors budget-check _effective_user_limits)", () => {
  const user = { dailyBudget: 50, weeklyBudget: 0, monthlyBudget: 200 };
  const dept = { perUserWeeklyBudget: 100, perUserDailyBudget: 30 };
  it("resolves each period independently", () => {
    expect(resolvePeriodBudget("daily", user, dept)).toEqual({ value: 50, source: "user" });
    expect(resolvePeriodBudget("weekly", user, dept)).toEqual({ value: 100, source: "dept" });
    expect(resolvePeriodBudget("monthly", user, dept)).toEqual({ value: 200, source: "user" });
  });
  it("falls back to globals, then no cap", () => {
    expect(resolvePeriodBudget("daily", undefined, undefined, { daily: 50 })).toEqual({ value: 50, source: "global" });
    expect(resolvePeriodBudget("weekly", undefined, undefined, { daily: 50 })).toEqual({ value: 0, source: "none" });
  });
});

describe("exceededPeriods", () => {
  it("any period at or over its cap counts; 0 = no cap", () => {
    expect(exceededPeriods({ daily: 10, weekly: 100, monthly: 120 }, { daily: 50, weekly: 100, monthly: 200 })).toEqual(["weekly"]);
    expect(exceededPeriods({ daily: 999 }, { daily: 0 })).toEqual([]);
  });
});
