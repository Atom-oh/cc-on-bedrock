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

/** user explicit > dept per-user default > global (env); 0 everywhere = no cap.
 *  An active one-time grant is added only to a capped period (value = base + grant). */
export function resolvePeriodBudget(
  period: BudgetPeriod,
  user: UserPeriodBudgets | undefined,
  dept: DeptPeriodDefaults | undefined,
  globals: Partial<PeriodValues> = {},
  grant = 0,
): { value: number; source: BudgetSource; base: number; grant: number } {
  const u = Number(user?.[USER_FIELD[period]] ?? 0);
  const d = Number(dept?.[DEPT_FIELD[period]] ?? 0);
  const g = Number(globals[period] ?? 0);
  const [base, source]: [number, BudgetSource] =
    u > 0 ? [u, "user"] : d > 0 ? [d, "dept"] : g > 0 ? [g, "global"] : [0, "none"];
  return { value: base > 0 ? base + grant : 0, source, base, grant };
}

/** Periods whose spend has reached its (non-zero) cap. */
export function exceededPeriods(spend: Partial<PeriodValues>, caps: Partial<PeriodValues>): BudgetPeriod[] {
  return BUDGET_PERIODS.filter((p) => (caps[p] ?? 0) > 0 && (spend[p] ?? 0) >= (caps[p] ?? 0));
}
