// ADR-008: per-user USD budgets are three independent caps (daily / weekly / monthly);
// exceeding ANY one blocks the user. Pure mirror of lambda/budget-check.py
// `_effective_user_limits` so the admin UI can show the resolved caps before the
// next budget-check run has written `effective*Budget`.

export const BUDGET_PERIODS = ["daily", "weekly", "monthly"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export type PeriodValues = Record<BudgetPeriod, number>;
export type BudgetSource = "user" | "dept" | "global" | "none";

export interface UserPeriodBudgets {
  dailyBudget?: number;
  weeklyBudget?: number;
  monthlyBudget?: number;
}

export interface DeptPeriodDefaults {
  perUserDailyBudget?: number;
  perUserWeeklyBudget?: number;
  perUserMonthlyBudget?: number;
}

const USER_FIELD: Record<BudgetPeriod, keyof UserPeriodBudgets> = {
  daily: "dailyBudget", weekly: "weeklyBudget", monthly: "monthlyBudget",
};
const DEPT_FIELD: Record<BudgetPeriod, keyof DeptPeriodDefaults> = {
  daily: "perUserDailyBudget", weekly: "perUserWeeklyBudget", monthly: "perUserMonthlyBudget",
};

/** user explicit > dept per-user default > global (env); 0 everywhere = no cap. */
export function resolvePeriodBudget(
  period: BudgetPeriod,
  user: UserPeriodBudgets | undefined,
  dept: DeptPeriodDefaults | undefined,
  globals: Partial<PeriodValues> = {},
): { value: number; source: BudgetSource } {
  const u = Number(user?.[USER_FIELD[period]] ?? 0);
  if (u > 0) return { value: u, source: "user" };
  const d = Number(dept?.[DEPT_FIELD[period]] ?? 0);
  if (d > 0) return { value: d, source: "dept" };
  const g = Number(globals[period] ?? 0);
  if (g > 0) return { value: g, source: "global" };
  return { value: 0, source: "none" };
}

/** Periods whose spend has reached its (non-zero) cap. */
export function exceededPeriods(spend: Partial<PeriodValues>, caps: Partial<PeriodValues>): BudgetPeriod[] {
  return BUDGET_PERIODS.filter((p) => (caps[p] ?? 0) > 0 && (spend[p] ?? 0) >= (caps[p] ?? 0));
}
