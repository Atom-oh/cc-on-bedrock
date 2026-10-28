/**
 * ADR-026 T7 — approval authorization (pure, dependency-free so it is unit-testable
 * without loading the Next route's server/AWS imports).
 *
 * Admin may approve any request. A dept-manager may approve ONLY requests whose
 * STORED department equals their own — the route reads the request from DynamoDB
 * and passes that stored value here, never a client-supplied one.
 *
 * Nobody may approve their own request (email compared case-insensitively).
 */
import type { BudgetPeriod } from "./budget-periods";
import { isCurrentPeriodKey } from "./budget-grants";

export interface ApproverUser {
  email: string;
  isAdmin: boolean;
  groups?: string[];
  department?: string;
}

export function isApprover(user: ApproverUser): boolean {
  return !!user.isAdmin || (user.groups ?? []).includes("dept-manager");
}

// Fail closed: a missing identity on either side counts as "self".
function isSelf(a: string | undefined, b: string | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  return x === "" || y === "" || x === y;
}

export function canApproveRequest(
  user: ApproverUser,
  requestDepartment: string,
  requesterEmail: string,
): boolean {
  if (isSelf(user.email, requesterEmail)) return false;
  if (user.isAdmin) return true;
  const isDeptMgr = (user.groups ?? []).includes("dept-manager");
  return isDeptMgr && !!user.department && user.department === requestDepartment;
}

export type BudgetDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "self"
        | "invalid_amount"
        | "not_approver"
        | "other_department"
        | "requester_is_manager"
        | "exceeds_department"
        | "expired";
    };

export interface DepartmentBudgetState {
  monthlyBudget: number;
  monthSpend: number;
  monthGranted: number;
}

/** monthlyBudget 0 means "no department limit". */
export function exceedsDepartment(dept: DepartmentBudgetState, amount: number): boolean {
  return dept.monthlyBudget > 0 && dept.monthSpend + dept.monthGranted + amount > dept.monthlyBudget;
}

/**
 * Order: self -> invalid_amount -> expired -> admin ok -> not_approver -> other_department ->
 * requester_is_manager -> exceeds_department -> ok.
 */
export function canApproveBudgetIncrease(
  user: ApproverUser,
  req: {
    email: string;
    department: string;
    period: BudgetPeriod;
    periodKey: string;
    requesterIsDeptManager: boolean;
  },
  amount: number,
  dept: DepartmentBudgetState,
  now: Date,
): BudgetDecision {
  if (isSelf(user.email, req.email)) return { ok: false, reason: "self" };
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(dept.monthlyBudget) ||
    !Number.isFinite(dept.monthSpend) ||
    !Number.isFinite(dept.monthGranted)
  ) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (!isCurrentPeriodKey(req.period, req.periodKey, now)) return { ok: false, reason: "expired" };
  if (user.isAdmin) return { ok: true };
  if (!isApprover(user)) return { ok: false, reason: "not_approver" };
  if (!user.department || user.department !== req.department) return { ok: false, reason: "other_department" };
  if (req.requesterIsDeptManager) return { ok: false, reason: "requester_is_manager" };
  if (exceedsDepartment(dept, amount)) return { ok: false, reason: "exceeds_department" };
  return { ok: true };
}
