import { describe, it, expect } from "vitest";
import {
  isUnlimitedCap,
  formatBudgetCap,
  formatTokenCap,
  usagePercent,
  blockCause,
} from "../budget-display";

describe("budget-display — cap <= 0 means unlimited (matches budget-check.py)", () => {
  it("treats 0, negative, null, undefined caps as unlimited", () => {
    expect(isUnlimitedCap(0)).toBe(true);
    expect(isUnlimitedCap(-5)).toBe(true);
    expect(isUnlimitedCap(null)).toBe(true);
    expect(isUnlimitedCap(undefined)).toBe(true);
    expect(isUnlimitedCap(1000)).toBe(false);
  });

  it("formats USD cap: 'Unlimited' when uncapped, else $N.NN", () => {
    expect(formatBudgetCap(0)).toBe("Unlimited");
    expect(formatBudgetCap(2000)).toBe("$2000.00");
  });

  it("formats token cap: 'Unlimited' when uncapped, else locale number", () => {
    expect(formatTokenCap(0)).toBe("Unlimited");
    expect(formatTokenCap(10000000)).toBe((10000000).toLocaleString());
  });

  it("usagePercent is null when unlimited (no divide-by-zero NaN), else clamped 0-100", () => {
    expect(usagePercent(500, 0)).toBeNull(); // was NaN% before the fix
    expect(usagePercent(500, 1000)).toBe(50);
    expect(usagePercent(5000, 1000)).toBe(100); // clamp high
    expect(usagePercent(0, 1000)).toBe(0);
  });
});

describe("blockCause — why the user is blocked (department, then personal period, then token)", () => {
  it("is null when nothing blocks", () => {
    expect(blockCause({})).toBeNull();
    expect(blockCause({ exceeded: [], departmentOver: false, tokenDenied: false })).toBeNull();
  });

  it("department deny wins over every other cause (a personal grant cannot lift it)", () => {
    expect(blockCause({ exceeded: ["daily"], departmentOver: true, tokenDenied: true })).toBe("department");
    expect(blockCause({ departmentOver: true })).toBe("department");
  });

  it("then the first exceeded personal period in daily -> weekly -> monthly order", () => {
    expect(blockCause({ exceeded: ["monthly", "daily"] })).toBe("user_daily");
    expect(blockCause({ exceeded: ["monthly", "weekly"], tokenDenied: true })).toBe("user_weekly");
    expect(blockCause({ exceeded: ["monthly"] })).toBe("user_monthly");
  });

  it("ignores unknown period names", () => {
    expect(blockCause({ exceeded: ["yearly"] })).toBeNull();
    expect(blockCause({ exceeded: ["yearly"], tokenDenied: true })).toBe("token");
  });

  it("token deny is the last cause", () => {
    expect(blockCause({ tokenDenied: true })).toBe("token");
  });
});
