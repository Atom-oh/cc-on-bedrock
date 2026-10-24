// One-time budget increase requests (both deployment modes). Pure DynamoDB
// transaction builders + a thin executor. The request lives in the approval table
// (`REQUEST#{id}`/`META`); a lock item `PENDING#{email}#{period}#{key}` makes at most
// one pending request per user and period window. Approval ADDs the amount to every
// cascade window's `grant#{period}#{key}` on the cc-user-budgets row and to the
// department's `grant#monthly#{key}` running total (department-cap accounting).

import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type TransactWriteItem,
  type TransactWriteItemsInput,
} from "@aws-sdk/client-dynamodb";
import { BUDGET_PERIODS, resolvePeriodBudget, type BudgetPeriod } from "./budget-periods";
import { cascadeTargets, grantAttr, periodKey } from "./budget-grants";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
export const APPROVAL_TABLE = process.env.APPROVAL_TABLE ?? "cc-on-bedrock-approval-requests";
export const USER_BUDGETS_TABLE = process.env.USER_BUDGETS_TABLE ?? "cc-user-budgets";
export const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";

export const MAX_INCREASE_USD = 10000;
export const MAX_REASON_LENGTH = 500;
/** budget-check runs every 5 minutes; a grant takes effect on its next run. */
export const RELEASE_ETA_MINUTES = 5;

export interface BudgetIncreaseRecord {
  requestId: string;
  email: string; // lowercase
  department: string;
  period: BudgetPeriod;
  periodKey: string;
}

export interface NewBudgetIncreaseRequest extends BudgetIncreaseRecord {
  subdomain: string;
  requesterRole: string;
  requestedAmount: number;
  reason: string;
  snapshotSpend: number;
  snapshotBudget: number;
  requestedAt: string;
}

export function lockKey(email: string, period: BudgetPeriod, key: string): string {
  return `PENDING#${email.trim().toLowerCase()}#${period}#${key}`;
}

const requestKey = (requestId: string) => ({ PK: { S: `REQUEST#${requestId}` }, SK: { S: "META" } });
const lockDelete = (req: BudgetIncreaseRecord): TransactWriteItem => ({
  Delete: {
    TableName: APPROVAL_TABLE,
    Key: { PK: { S: lockKey(req.email, req.period, req.periodKey) }, SK: { S: "META" } },
  },
});
const num = (n: number) => ({ N: String(n) });

export function isBudgetPeriod(p: unknown): p is BudgetPeriod {
  return typeof p === "string" && (BUDGET_PERIODS as readonly string[]).includes(p);
}

export type IncreaseInputError = "invalid_period" | "invalid_amount" | "invalid_reason";

/** POST body validation: period first (cascadeTargets mishandles unknown periods). */
export function validateIncreaseInput(
  body: Record<string, unknown>,
): { ok: true; period: BudgetPeriod; requestedAmount: number; reason: string } | { ok: false; error: IncreaseInputError } {
  if (!isBudgetPeriod(body.period)) return { ok: false, error: "invalid_period" };
  const amount = body.requestedAmount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_INCREASE_USD) {
    return { ok: false, error: "invalid_amount" };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 1 || reason.length > MAX_REASON_LENGTH) return { ok: false, error: "invalid_reason" };
  return { ok: true, period: body.period, requestedAmount: amount, reason };
}

export function isValidIncreaseAmount(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 && amount <= MAX_INCREASE_USD;
}

const EFFECTIVE_FIELD: Record<BudgetPeriod, string> = {
  daily: "effectiveDailyBudget",
  weekly: "effectiveWeeklyBudget",
  monthly: "effectiveMonthlyBudget",
};
const SPEND_FIELD: Record<BudgetPeriod, string> = {
  daily: "currentDailySpend",
  weekly: "currentWeeklySpend",
  monthly: "currentMonthlySpend",
};

type Row = Record<string, unknown> | undefined;

/**
 * Whether the period has a non-zero base cap. Same resolution as the admin budgets UI:
 * the client mirror (user explicit > dept per-user default), else the cap budget-check
 * last enforced (effective*Budget, which includes the global env default the dashboard
 * does not know). A grant is only ever added to a capped period, so effective > 0
 * implies base > 0.
 */
export function periodIsCapped(period: BudgetPeriod, userRow: Row, deptRow: Row): boolean {
  if (resolvePeriodBudget(period, userRow, deptRow).base > 0) return true;
  return Number(userRow?.[EFFECTIVE_FIELD[period]] ?? 0) > 0;
}

/** Spend and resolved cap at request time, shown to the approver. */
export function periodSnapshot(period: BudgetPeriod, userRow: Row, deptRow: Row): { spend: number; budget: number } {
  const spend = Number(userRow?.[SPEND_FIELD[period]] ?? 0) || 0;
  const enforced = Number(userRow?.[EFFECTIVE_FIELD[period]] ?? 0) || 0;
  const budget = enforced > 0 ? enforced : resolvePeriodBudget(period, userRow, deptRow).value;
  return { spend, budget };
}

/** `grant#*` attributes on a user row whose window is no longer current. */
export function staleGrantAttrs(row: Record<string, unknown>, now: Date): string[] {
  const current = new Set(BUDGET_PERIODS.map((p) => grantAttr(p, periodKey(p, now))));
  return Object.keys(row).filter((k) => k.startsWith("grant#") && !current.has(k));
}

export function buildCreateTransaction(req: NewBudgetIncreaseRequest): TransactWriteItemsInput {
  return {
    TransactItems: [
      {
        Put: {
          TableName: APPROVAL_TABLE,
          Item: {
            ...requestKey(req.requestId),
            requestId: { S: req.requestId },
            type: { S: "budget_increase" },
            email: { S: req.email.trim().toLowerCase() },
            subdomain: { S: req.subdomain },
            department: { S: req.department },
            requesterRole: { S: req.requesterRole },
            period: { S: req.period },
            periodKey: { S: req.periodKey },
            requestedAmount: num(req.requestedAmount),
            reason: { S: req.reason },
            snapshotSpend: num(req.snapshotSpend),
            snapshotBudget: num(req.snapshotBudget),
            status: { S: "pending" },
            requestedAt: { S: req.requestedAt },
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        // No `email` attribute: email-filtered request scans must not pick the lock up.
        Put: {
          TableName: APPROVAL_TABLE,
          Item: {
            PK: { S: lockKey(req.email, req.period, req.periodKey) },
            SK: { S: "META" },
            requestId: { S: req.requestId },
            createdAt: { S: req.requestedAt },
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ],
  };
}

export interface AppliedGrant {
  period: BudgetPeriod;
  key: string;
  attr: string;
  amount: number;
}

/** The user-row grants an approval writes (cascade targets minus uncapped periods). */
export function approvedGrants(
  req: BudgetIncreaseRecord,
  amount: number,
  now: Date,
  skipPeriods: BudgetPeriod[] = [],
): AppliedGrant[] {
  return cascadeTargets(req.period, now)
    .filter((t) => !skipPeriods.includes(t.period))
    .map((t) => ({ ...t, attr: grantAttr(t.period, t.key), amount }));
}

export function buildApproveTransaction(
  req: BudgetIncreaseRecord,
  amount: number,
  approverEmail: string,
  now: Date,
  opts: { skipPeriods?: BudgetPeriod[] } = {},
): TransactWriteItemsInput {
  const items: TransactWriteItem[] = [
    {
      Update: {
        TableName: APPROVAL_TABLE,
        Key: requestKey(req.requestId),
        UpdateExpression: "SET #s = :status, approvedBy = :by, approvedAt = :at, approvedAmount = :amt",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": { S: "approved" },
          ":pending": { S: "pending" },
          ":by": { S: approverEmail },
          ":at": { S: now.toISOString() },
          ":amt": num(amount),
        },
      },
    },
    lockDelete(req),
  ];

  const grants = approvedGrants(req, amount, now, opts.skipPeriods);
  if (grants.length > 0) {
    const names: Record<string, string> = {};
    grants.forEach((g, i) => (names[`#g${i}`] = g.attr));
    items.push({
      Update: {
        TableName: USER_BUDGETS_TABLE,
        Key: { user_id: { S: req.email.trim().toLowerCase() } },
        UpdateExpression: `ADD ${grants.map((_, i) => `#g${i} :amt`).join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ":amt": num(amount) },
      },
    });
  }

  if (req.department) {
    items.push({
      Update: {
        TableName: DEPT_BUDGETS_TABLE,
        Key: { dept_id: { S: req.department } },
        UpdateExpression: "ADD #g :amt",
        ExpressionAttributeNames: { "#g": grantAttr("monthly", periodKey("monthly", now)) },
        ExpressionAttributeValues: { ":amt": num(amount) },
      },
    });
  }
  return { TransactItems: items };
}

function closeTransaction(
  req: BudgetIncreaseRecord,
  status: "rejected" | "expired",
  set: string[],
  values: Record<string, { S: string }>,
): TransactWriteItemsInput {
  return {
    TransactItems: [
      {
        Update: {
          TableName: APPROVAL_TABLE,
          Key: requestKey(req.requestId),
          UpdateExpression: `SET ${["#s = :status", ...set].join(", ")}`,
          ConditionExpression: "#s = :pending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":status": { S: status }, ":pending": { S: "pending" }, ...values },
        },
      },
      lockDelete(req),
    ],
  };
}

export function buildRejectTransaction(
  req: BudgetIncreaseRecord,
  approverEmail: string,
  reason: string,
  now: Date,
): TransactWriteItemsInput {
  const set = ["rejectedBy = :by", "rejectedAt = :at"];
  const values: Record<string, { S: string }> = { ":by": { S: approverEmail }, ":at": { S: now.toISOString() } };
  if (reason) {
    set.push("rejectReason = :reason");
    values[":reason"] = { S: reason };
  }
  return closeTransaction(req, "rejected", set, values);
}

export function buildExpireTransaction(req: BudgetIncreaseRecord, now: Date): TransactWriteItemsInput {
  return closeTransaction(req, "expired", ["expiredAt = :at"], { ":at": { S: now.toISOString() } });
}

// ─── Execution ───

const dynamodb = new DynamoDBClient({ region });

export async function runTransaction(input: TransactWriteItemsInput): Promise<void> {
  await dynamodb.send(new TransactWriteItemsCommand(input));
}

/** A failed condition (request no longer pending / lock already held). */
export function isTransactionCanceled(err: unknown): boolean {
  return err instanceof Error && err.name === "TransactionCanceledException";
}

/** Best-effort removal of past-window grants from the user row; failures are ignored. */
export async function removeStaleGrants(email: string, attrs: string[]): Promise<void> {
  if (attrs.length === 0) return;
  const names: Record<string, string> = {};
  attrs.forEach((a, i) => (names[`#o${i}`] = a));
  try {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: USER_BUDGETS_TABLE,
        Key: { user_id: { S: email.trim().toLowerCase() } },
        UpdateExpression: `REMOVE ${attrs.map((_, i) => `#o${i}`).join(", ")}`,
        ExpressionAttributeNames: names,
      }),
    );
  } catch (err) {
    console.warn("[budget-increase] stale grant cleanup failed:", err instanceof Error ? err.message : err);
  }
}
