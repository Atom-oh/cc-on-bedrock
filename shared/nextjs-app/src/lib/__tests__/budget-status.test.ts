import { describe, it, expect } from "vitest";
import { budgetStatus, departmentOver } from "../budget-status";

const NOW = new Date("2026-10-24T12:00:00Z");

describe("departmentOver — the department monthly total deny (budget-check)", () => {
  it("is over only when a total is set and spend reached it", () => {
    expect(departmentOver({ monthlyBudget: 100, currentSpend: 100 })).toBe(true);
    expect(departmentOver({ monthlyBudget: 100, currentSpend: 99.9 })).toBe(false);
    expect(departmentOver({ monthlyBudget: 0, currentSpend: 500 })).toBe(false);
    expect(departmentOver(undefined)).toBe(false);
  });
});

describe("budgetStatus — per-period base + current grant, exceeded periods and the block cause", () => {
  it("adds only the CURRENT window's grant to a capped period", () => {
    const s = budgetStatus(
      {
        dailyBudget: 10,
        currentDailySpend: 12,
        "grant#daily#2026-10-24": 5,
        "grant#daily#2026-10-23": 50, // past window: ignored
        "grant#monthly#2026-10": 5,
        budgetExceeded: ["daily"],
      },
      { perUserMonthlyBudget: 200 },
      NOW,
      false,
    );
    expect(s.periods.daily).toEqual({ spend: 12, base: 10, grant: 5, cap: 15 });
    expect(s.periods.monthly).toEqual({ spend: 0, base: 200, grant: 5, cap: 205 });
    expect(s.periods.weekly).toEqual({ spend: 0, base: 0, grant: 0, cap: 0 }); // unlimited
    expect(s.exceeded).toEqual(["daily"]);
    expect(s.blockCause).toBe("user_daily");
  });

  it("falls back to the enforced cap minus the enforced grant (global default)", () => {
    const s = budgetStatus(
      { effectiveDailyBudget: 25, activeGrantDaily: 5, "grant#daily#2026-10-24": 5, budgetExceeded: [] },
      undefined,
      NOW,
      false,
    );
    expect(s.periods.daily).toEqual({ spend: 0, base: 20, grant: 5, cap: 25 });
    expect(s.blockCause).toBeNull();
  });

  it("department deny outranks a personal period; token deny is last", () => {
    expect(
      budgetStatus({ budgetExceeded: ["weekly"] }, { monthlyBudget: 50, currentSpend: 60 }, NOW, true).blockCause,
    ).toBe("department");
    expect(budgetStatus({ budgetExceeded: [] }, undefined, NOW, true).blockCause).toBe("token");
  });

  it("a legacy row without budgetExceeded is evaluated on the monthly budget", () => {
    const s = budgetStatus({ monthlyBudget: 100, currentSpend: 120 }, undefined, NOW, false);
    expect(s.exceeded).toEqual(["monthly"]);
    expect(s.periods.monthly.spend).toBe(120);
    expect(s.blockCause).toBe("user_monthly");
  });

  it("no row at all is not blocked", () => {
    const s = budgetStatus(undefined, undefined, NOW, false);
    expect(s.exceeded).toEqual([]);
    expect(s.blockCause).toBeNull();
  });
});
