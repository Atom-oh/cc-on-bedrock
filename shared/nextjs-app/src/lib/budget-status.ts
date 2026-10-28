// Server-side budget status for the dashboard (user /local banner, dept and admin
// blocked lists): per-period "base + current one-time grant" and the block cause.
// Same cap resolution as the approval route (`periodBaseCap`) and budget-check:
// a grant counts only for a capped period and only in its current window.

import { BatchGetItemCommand, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { BUDGET_PERIODS, type BudgetPeriod } from "./budget-periods";
import { activeGrants } from "./budget-grants";
import { LIMITS_TABLE, USER_BUDGETS_TABLE, periodBaseCap } from "./budget-increase";
import { blockCause, type BlockCause } from "./budget-display";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const dynamodb = new DynamoDBClient({ region });

type Row = Record<string, unknown> | undefined;

export interface PeriodStatus {
  spend: number;
  /** Standing cap without grants; 0 = unlimited. */
  base: number;
  /** Current-window one-time grant (0 for an unlimited period). */
  grant: number;
  /** base + grant; 0 = unlimited. */
  cap: number;
}

export interface BudgetStatus {
  periods: Record<BudgetPeriod, PeriodStatus>;
  /** Periods budget-check last found over cap (the USD deny is attached for these). */
  exceeded: BudgetPeriod[];
  departmentOver: boolean;
  tokenDenied: boolean;
  blockCause: BlockCause;
}

const SPEND_FIELD: Record<BudgetPeriod, string> = {
  daily: "currentDailySpend",
  weekly: "currentWeeklySpend",
  monthly: "currentMonthlySpend",
};

const num = (v: unknown) => Number(v ?? 0) || 0;

/** The department monthly total is set and reached: budget-check denies every member. */
export function departmentOver(deptRow: Row): boolean {
  const total = num(deptRow?.monthlyBudget);
  return total > 0 && num(deptRow?.currentSpend) >= total;
}

export function budgetStatus(userRow: Row, deptRow: Row, now: Date, tokenDenied: boolean): BudgetStatus {
  const grants = activeGrants(userRow ?? {}, now);
  const periods = {} as Record<BudgetPeriod, PeriodStatus>;
  for (const p of BUDGET_PERIODS) {
    const base = periodBaseCap(p, userRow, deptRow);
    const grant = base > 0 ? grants[p] : 0;
    const spend = p === "monthly"
      ? num(userRow?.[SPEND_FIELD.monthly] ?? userRow?.currentSpend)
      : num(userRow?.[SPEND_FIELD[p]]);
    periods[p] = { spend, base, grant, cap: base > 0 ? base + grant : 0 };
  }

  let exceeded: BudgetPeriod[] = [];
  if (Array.isArray(userRow?.budgetExceeded)) {
    const listed = (userRow.budgetExceeded as unknown[]).map(String);
    exceeded = BUDGET_PERIODS.filter((p) => listed.includes(p));
  } else if (userRow) {
    // Row not yet written by the period-aware budget-check — legacy monthly evaluation.
    const budget = num(userRow.monthlyBudget);
    if (budget > 0 && num(userRow.currentSpend) >= budget) exceeded = ["monthly"];
  }

  const deptOver = departmentOver(deptRow);
  return {
    periods,
    exceeded,
    departmentOver: deptOver,
    tokenDenied,
    blockCause: blockCause({ exceeded, departmentOver: deptOver, tokenDenied }),
  };
}

/** Lowercased emails with an active token-limit deny (DENY#active rows in the limits table). */
export async function readTokenDeniedUsers(): Promise<Set<string>> {
  const out = new Set<string>();
  let startKey: Record<string, never> | undefined;
  do {
    const res = await dynamodb.send(new ScanCommand({
      TableName: LIMITS_TABLE,
      FilterExpression: "SK = :deny AND begins_with(PK, :user)",
      ExpressionAttributeValues: { ":deny": { S: "DENY#active" }, ":user": { S: "USER#" } },
      ProjectionExpression: "PK",
      ExclusiveStartKey: startKey,
    }));
    for (const item of res.Items ?? []) {
      const pk = String(unmarshall(item).PK ?? "");
      out.add(pk.slice("USER#".length).trim().toLowerCase());
    }
    startKey = res.LastEvaluatedKey as Record<string, never> | undefined;
  } while (startKey);
  return out;
}

/** cc-user-budgets rows by lowercased email (BatchGet, 100 keys per call). Missing rows are absent. */
export async function readUserBudgetRows(emails: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const keys = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  for (let i = 0; i < keys.length; i += 100) {
    let pending = keys.slice(i, i + 100).map((k) => ({ user_id: { S: k } }));
    // Bounded retry of unprocessed keys (throttling); whatever is left is shown as "no row".
    for (let attempt = 0; pending.length > 0 && attempt < 3; attempt++) {
      const res = await dynamodb.send(new BatchGetItemCommand({
        RequestItems: { [USER_BUDGETS_TABLE]: { Keys: pending } },
      }));
      for (const raw of res.Responses?.[USER_BUDGETS_TABLE] ?? []) {
        const row = unmarshall(raw);
        out.set(String(row.user_id ?? "").toLowerCase(), row);
      }
      pending = (res.UnprocessedKeys?.[USER_BUDGETS_TABLE]?.Keys ?? []) as typeof pending;
    }
  }
  return out;
}
