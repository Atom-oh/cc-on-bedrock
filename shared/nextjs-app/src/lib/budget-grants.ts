// One-time budget grants: UTC period keys and cascading targets. Pure mirror of
// lambda/budget-check.py `period_key` / `cascade_targets` / `grant_attr` / `active_grants`.
// Grants are flat numeric attributes `grant#{period}#{key}` on the cc-user-budgets row.

import { BUDGET_PERIODS, type BudgetPeriod, type PeriodValues } from "./budget-periods";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** UTC key of the window containing `now`: day `YYYY-MM-DD`, ISO week `YYYY-Www`, month `YYYY-MM`. */
export function periodKey(period: BudgetPeriod, now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === "daily") return `${pad(y, 4)}-${pad(m + 1)}-${pad(d)}`;
  if (period === "monthly") return `${pad(y, 4)}-${pad(m + 1)}`;
  // ISO week: shift to the Thursday of this week; that Thursday's year is the ISO year.
  const thursday = new Date(Date.UTC(y, m, d));
  thursday.setUTCDate(d + 4 - (now.getUTCDay() || 7));
  const isoYear = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000);
  return `${pad(isoYear, 4)}-W${pad(Math.floor(dayOfYear / 7) + 1)}`;
}

/** Requested period up through monthly: the windows a one-time grant raises. */
export function cascadeTargets(
  period: BudgetPeriod,
  now: Date,
): Array<{ period: BudgetPeriod; key: string }> {
  return BUDGET_PERIODS.slice(BUDGET_PERIODS.indexOf(period)).map((p) => ({
    period: p,
    key: periodKey(p, now),
  }));
}

export function grantAttr(period: BudgetPeriod, key: string): string {
  return `grant#${period}#${key}`;
}

/** Grant amounts whose key matches the current window; past windows are ignored. */
export function activeGrants(row: Record<string, unknown>, now: Date): PeriodValues {
  const out = {} as PeriodValues;
  for (const p of BUDGET_PERIODS) out[p] = Number(row[grantAttr(p, periodKey(p, now))] ?? 0) || 0;
  return out;
}

export function isCurrentPeriodKey(period: BudgetPeriod, key: string, now: Date): boolean {
  return key === periodKey(period, now);
}
