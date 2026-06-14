import { describe, it, expect } from "vitest";
import {
  isUnlimitedCap,
  formatBudgetCap,
  formatTokenCap,
  usagePercent,
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
