import { describe, it, expect } from "vitest";
import { periodKey, cascadeTargets, grantAttr, activeGrants, isCurrentPeriodKey } from "../budget-grants";

const NOW = new Date(Date.UTC(2026, 9, 24, 3)); // Sat, ISO 2026-W43

describe("budget-grants (mirrors lambda/budget-check.py)", () => {
  it("periodKey is UTC / ISO-week based", () => {
    expect(periodKey("daily", NOW)).toBe("2026-10-24");
    expect(periodKey("weekly", NOW)).toBe("2026-W43");
    expect(periodKey("monthly", NOW)).toBe("2026-10");
    expect(periodKey("weekly", new Date(Date.UTC(2027, 0, 1)))).toBe("2026-W53");
  });

  it("grantAttr", () => {
    expect(grantAttr("daily", "2026-10-24")).toBe("grant#daily#2026-10-24");
  });

  it("cascadeTargets runs from the requested period up to monthly", () => {
    expect(cascadeTargets("daily", NOW)).toEqual([
      { period: "daily", key: "2026-10-24" },
      { period: "weekly", key: "2026-W43" },
      { period: "monthly", key: "2026-10" },
    ]);
    expect(cascadeTargets("weekly", NOW)).toEqual([
      { period: "weekly", key: "2026-W43" },
      { period: "monthly", key: "2026-10" },
    ]);
    expect(cascadeTargets("monthly", NOW)).toEqual([{ period: "monthly", key: "2026-10" }]);
  });

  it("week crossing a month boundary", () => {
    const fri = new Date(Date.UTC(2026, 9, 30, 12));
    expect(cascadeTargets("daily", fri)).toEqual([
      { period: "daily", key: "2026-10-30" },
      { period: "weekly", key: "2026-W44" },
      { period: "monthly", key: "2026-10" },
    ]);
    const row = { "grant#daily#2026-10-30": 20, "grant#weekly#2026-W44": 20, "grant#monthly#2026-10": 20 };
    expect(activeGrants(row, new Date(Date.UTC(2026, 10, 1, 1)))).toEqual({ daily: 0, weekly: 20, monthly: 0 });
  });

  it("activeGrants ignores stale and non-grant attrs", () => {
    const row = { "grant#daily#2026-10-23": 5, "grant#daily#2026-10-24": 7, dailyBudget: 50 };
    expect(activeGrants(row, NOW)).toEqual({ daily: 7, weekly: 0, monthly: 0 });
  });

  it("isCurrentPeriodKey", () => {
    expect(isCurrentPeriodKey("daily", "2026-10-24", NOW)).toBe(true);
    expect(isCurrentPeriodKey("daily", "2026-10-23", NOW)).toBe(false);
  });
});
