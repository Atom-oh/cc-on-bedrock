// Budget display helpers — keep the dashboard consistent with budget-check.py
// enforcement semantics: a cap <= 0 (0 or unset) means NO limit is enforced
// (`if monthly_limit <= 0: continue` / `if mx <= 0: continue`), i.e. UNLIMITED.
// The dashboard must show "Unlimited", not a misleading $0.00 / NaN%.

/** A cap (USD budget or token limit) of 0 or less means unlimited (no enforcement). */
export function isUnlimitedCap(cap: number | null | undefined): boolean {
  return !(typeof cap === "number" && cap > 0);
}

/** Format a USD budget cap for display: "Unlimited" when uncapped, else "$N.NN". */
export function formatBudgetCap(cap: number | null | undefined): string {
  return isUnlimitedCap(cap) ? "Unlimited" : `$${(cap as number).toFixed(2)}`;
}

/** Format a token limit for display: "Unlimited" when uncapped, else locale number. */
export function formatTokenCap(cap: number | null | undefined): string {
  return isUnlimitedCap(cap) ? "Unlimited" : (cap as number).toLocaleString();
}

/**
 * Usage percent against a cap. Returns null when the cap is unlimited (no
 * meaningful percentage — avoids divide-by-zero → NaN). Otherwise clamped 0–100.
 */
export function usagePercent(used: number, cap: number | null | undefined): number | null {
  if (isUnlimitedCap(cap)) return null;
  return Math.min(100, Math.max(0, Math.round((used / (cap as number)) * 100)));
}
