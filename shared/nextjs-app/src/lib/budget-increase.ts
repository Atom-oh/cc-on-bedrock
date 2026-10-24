// One-time budget increase requests (both deployment modes). Pure DynamoDB
// transaction builders + a thin executor. The request lives in the approval table
// (`REQUEST#{id}`/`META`); a lock item `PENDING#{email}#{period}#{key}` makes at most
// one pending request per user and period window. Approval ADDs the amount to every
// cascade window's `grant#{period}#{key}` on the cc-user-budgets row and to the
// department's `grant#monthly#{key}` running total (department-cap accounting).
// The token axis (token-limit-enforcer, KST buckets) is lifted separately by
// `releaseTokenAxis` once the approval has committed.

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type TransactWriteItem,
  type TransactWriteItemsInput,
} from "@aws-sdk/client-dynamodb";
import { BUDGET_PERIODS, resolvePeriodBudget, type BudgetPeriod } from "./budget-periods";
import { cascadeTargets, grantAttr, isCurrentPeriodKey, periodKey } from "./budget-grants";
import {
  canApproveBudgetIncrease,
  canApproveRequest,
  type ApproverUser,
  type DepartmentBudgetState,
} from "./approval-authz";
import type { Role } from "./roles";
import { releaseTokenDeny } from "./token-deny";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
export const APPROVAL_TABLE = process.env.APPROVAL_TABLE ?? "cc-on-bedrock-approval-requests";
export const USER_BUDGETS_TABLE = process.env.USER_BUDGETS_TABLE ?? "cc-user-budgets";
export const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
export const LIMITS_TABLE = process.env.LIMITS_TABLE ?? "cc-on-bedrock-limits";
// Same USD → normalized-token rate as the LIMIT#monthly mirror in /api/admin/budgets.
export const NORMALIZED_PER_USD = Number(process.env.NORMALIZED_PER_USD ?? "66667");

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

const ACTIVE_GRANT_FIELD: Record<BudgetPeriod, string> = {
  daily: "activeGrantDaily",
  weekly: "activeGrantWeekly",
  monthly: "activeGrantMonthly",
};

/** The period's base cap (without grants); 0 = uncapped. Same sources as `periodIsCapped`. */
export function periodBaseCap(period: BudgetPeriod, userRow: Row, deptRow: Row): number {
  const mirror = resolvePeriodBudget(period, userRow, deptRow).base;
  if (mirror > 0) return mirror;
  const enforced = Number(userRow?.[EFFECTIVE_FIELD[period]] ?? 0) || 0;
  if (enforced <= 0) return 0;
  const base = enforced - (Number(userRow?.[ACTIVE_GRANT_FIELD[period]] ?? 0) || 0);
  return base > 0 ? base : enforced;
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
  opts: { skipPeriods?: BudgetPeriod[]; deptCondition?: DeptCondition } = {},
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
    // Optimistic guard for the department-cap check: the month's granted total must
    // still be what the approver's check read (absent/0 → still absent or 0).
    const seen = opts.deptCondition?.seenGrant;
    const guarded = opts.deptCondition !== undefined;
    const hasSeen = guarded && seen !== null && seen !== undefined && Number(seen) !== 0;
    items.push({
      Update: {
        TableName: DEPT_BUDGETS_TABLE,
        Key: { dept_id: { S: req.department } },
        UpdateExpression: "ADD #g :amt",
        ...(guarded
          ? { ConditionExpression: hasSeen ? "#g = :seen" : "attribute_not_exists(#g) OR #g = :zero" }
          : {}),
        ExpressionAttributeNames: { "#g": grantAttr("monthly", periodKey("monthly", now)) },
        ExpressionAttributeValues: {
          ":amt": num(amount),
          ...(hasSeen ? { ":seen": { N: String(seen) } } : guarded ? { ":zero": num(0) } : {}),
        },
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

/** Raw DynamoDB N string of the department's month grant as read (null = absent). */
export interface DeptCondition {
  seenGrant: string | null;
}

export interface StoredBudgetRequest {
  type: string;
  email: string;
  department: string;
  status: string;
  period: unknown;
  periodKey: unknown;
  requestedAmount: unknown;
}

export type BudgetAction =
  | { kind: "deny"; status: number; error: string }
  | { kind: "already_processed"; status: string }
  | { kind: "expire" }
  | { kind: "reject" }
  | { kind: "approve"; amount: number; deptCondition?: DeptCondition };

function sameEmail(a: string | undefined, b: string | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  return x === "" || y === "" || x === y; // missing identity fails closed as "self"
}

/**
 * The approval decision for one request, from fresh inputs. Order:
 * self -> admin_only_request_type -> other_department -> requester_is_manager ->
 * status pending -> expired -> (reject) -> invalid_amount -> unlimited_period ->
 * exceeds_department -> approve. A dept-manager approval carries a department
 * condition so a concurrent grant cannot slip past the department cap.
 */
export function decideBudgetAction(input: {
  approver: ApproverUser;
  request: StoredBudgetRequest;
  requesterRole: Role;
  action: "approve" | "reject";
  amount?: unknown;
  dept: DepartmentBudgetState;
  seenDeptGrant?: string | null;
  baseCap: number;
  now: Date;
}): BudgetAction {
  const { approver, request, now } = input;
  const deny = (status: number, error: string): BudgetAction => ({ kind: "deny", status, error });

  if (sameEmail(approver.email, request.email)) return deny(403, "self");
  if (!approver.isAdmin && request.type !== "budget_increase") return deny(403, "admin_only_request_type");
  if (!canApproveRequest(approver, request.department, request.email)) return deny(403, "other_department");
  if (!approver.isAdmin && input.requesterRole !== "user") return deny(403, "requester_is_manager");
  if (request.status !== "pending") return { kind: "already_processed", status: request.status };
  if (request.type !== "budget_increase" || !isBudgetPeriod(request.period) || typeof request.periodKey !== "string") {
    return deny(400, "malformed_request");
  }
  if (!isCurrentPeriodKey(request.period, request.periodKey, now)) return { kind: "expire" };
  if (input.action === "reject") return { kind: "reject" };

  const amount = input.amount === undefined ? Number(request.requestedAmount) : input.amount;
  if (!isValidIncreaseAmount(amount)) return deny(400, "invalid_amount");
  if (!(input.baseCap > 0)) return deny(409, "unlimited_period");

  const check = canApproveBudgetIncrease(
    approver,
    {
      email: request.email,
      department: request.department,
      period: request.period,
      periodKey: request.periodKey,
      requesterIsDeptManager: input.requesterRole !== "user",
    },
    amount,
    input.dept,
    now,
  );
  if (!check.ok) return deny(check.reason === "invalid_amount" ? 400 : 403, check.reason);

  const guard = !approver.isAdmin && input.dept.monthlyBudget > 0;
  return guard
    ? { kind: "approve", amount, deptCondition: { seenGrant: input.seenDeptGrant ?? null } }
    : { kind: "approve", amount };
}

export type TxItemRole = "request" | "lock" | "user" | "department";

function txItemRole(item: TransactWriteItem): TxItemRole {
  const op = item.Put ?? item.Update ?? item.Delete ?? item.ConditionCheck;
  if (op?.TableName === USER_BUDGETS_TABLE) return "user";
  if (op?.TableName === DEPT_BUDGETS_TABLE) return "department";
  const pk = (item.Put?.Item ?? (op as { Key?: Record<string, { S?: string }> } | undefined)?.Key)?.PK?.S ?? "";
  return pk.startsWith("PENDING#") ? "lock" : "request";
}

/**
 * Why a transaction was canceled: null = not a cancellation; "retry" = a non-condition
 * cause (TransactionConflict, throttling, missing reasons); otherwise the items whose
 * condition failed.
 */
export function classifyCancellation(
  err: unknown,
  tx: TransactWriteItemsInput,
): null | "retry" | { failed: TxItemRole[] } {
  if (!(err instanceof Error) || err.name !== "TransactionCanceledException") return null;
  const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return "retry";
  const failed: TxItemRole[] = [];
  for (let i = 0; i < reasons.length; i++) {
    const code = reasons[i]?.Code ?? "None";
    if (code === "None") continue;
    if (code !== "ConditionalCheckFailed") return "retry";
    const item = tx.TransactItems?.[i];
    if (item) failed.push(txItemRole(item));
  }
  return failed.length > 0 ? { failed } : "retry";
}

// ─── Execution ───

const dynamodb = new DynamoDBClient({ region });

export async function runTransaction(input: TransactWriteItemsInput): Promise<void> {
  await dynamodb.send(new TransactWriteItemsCommand(input));
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

// ─── Token axis ───

/** KST `YYYY-MM`: token-limit-enforcer `_bucket_for(now, "monthly")`. */
export function kstMonthBucket(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  return `${String(kst.getUTCFullYear()).padStart(4, "0")}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface TokenRelease {
  released: boolean;
  warning?: string;
  /** KST month the grant was written under. */
  bucket?: string;
  /** Normalized tokens added to LIMIT#monthly (0 = no token limit row, nothing written). */
  normalizedGranted?: number;
  /** Whether an active token deny was detached and cleared. */
  denyCleared?: boolean;
}

const isConditionFailure = (err: unknown) =>
  err instanceof ConditionalCheckFailedException ||
  (err instanceof Error && err.name === "ConditionalCheckFailedException");

/**
 * Add `normalized` to the user's LIMIT#monthly grant for `bucket`: ADD when the stored
 * `grant_bucket` matches, otherwise replace the past month's grant. Returns false when
 * the row does not exist (no token limit configured), in which case nothing is written.
 */
async function addTokenGrant(email: string, bucket: string, normalized: number): Promise<boolean> {
  const Key = { PK: { S: `USER#${email}` }, SK: { S: "LIMIT#monthly" } };
  const values = { ":b": { S: bucket }, ":n": num(normalized) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await dynamodb.send(new UpdateItemCommand({
        TableName: LIMITS_TABLE,
        Key,
        UpdateExpression: "ADD grant_normalized :n",
        ConditionExpression: "attribute_exists(PK) AND grant_bucket = :b",
        ExpressionAttributeValues: values,
      }));
      return true;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
    try {
      await dynamodb.send(new UpdateItemCommand({
        TableName: LIMITS_TABLE,
        Key,
        UpdateExpression: "SET grant_bucket = :b, grant_normalized = :n",
        ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(grant_bucket) OR grant_bucket <> :b)",
        ExpressionAttributeValues: values,
      }));
      return true;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
    // Both conditions failed: the row is absent, or a concurrent approval just moved
    // the bucket to this month (then the ADD succeeds on the next attempt).
    const got = await dynamodb.send(new GetItemCommand({ TableName: LIMITS_TABLE, Key, ProjectionExpression: "PK" }));
    if (!got.Item) return false;
  }
  throw new Error("token grant contention");
}

/**
 * Lift the normalized-token axis for an approved grant of `amount` USD: every approval
 * cascades to monthly, so floor(amount × NORMALIZED_PER_USD) is added to the user's
 * LIMIT#monthly grant for the KST month (only if the row exists), then an active token
 * deny is released. Never throws: a failure is `{ released: false, warning }`.
 */
export async function releaseTokenAxis(email: string, amount: number, now: Date): Promise<TokenRelease> {
  const user = email.trim().toLowerCase();
  const bucket = kstMonthBucket(now);
  const normalized = Math.floor(amount * NORMALIZED_PER_USD);
  let granted = 0;
  try {
    if (normalized > 0 && (await addTokenGrant(user, bucket, normalized))) granted = normalized;
    const deny = await releaseTokenDeny(user);
    const base = { bucket, normalizedGranted: granted, denyCleared: deny.released };
    if (deny.found && !deny.released) return { released: false, warning: deny.warning, ...base };
    return { released: true, ...base };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[budget-increase] token axis release failed:", msg);
    return { released: false, warning: `token axis not released: ${msg}`, bucket, normalizedGranted: granted };
  }
}
