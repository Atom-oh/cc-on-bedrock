// Pure client-side rules for the budget screens (approvals page, sidebar badge,
// request form, dept limit editor). The server re-checks everything; these only
// decide what to show and which buttons to disable.

import type { DeploymentMode } from "./deployment-mode";
import { BUDGET_PERIODS, type BudgetPeriod } from "./budget-periods";
import { isCurrentPeriodKey } from "./budget-grants";
import { exceedsDepartment, type DepartmentBudgetState } from "./approval-authz";

/** Same bounds as lib/budget-increase (MAX_INCREASE_USD, MAX_REASON_LENGTH). */
export const MAX_INCREASE_USD = 10000;
export const MAX_REASON_LENGTH = 500;

/** Instance-permission request types: devEnv edition only (spec §2). */
export const DEVENV_ONLY_REQUEST_TYPES = new Set(["iam_extension", "tier_change", "dlp_change", "container_request"]);

export function isRequestTypeVisible(type: string, mode: DeploymentMode): boolean {
  return mode === "devenv" || !DEVENV_ONLY_REQUEST_TYPES.has(type);
}

export interface ApprovalViewer {
  email: string;
  isAdmin: boolean;
}

export interface ViewRequest {
  type: string;
  email: string;
  status: string;
  period?: string;
  periodKey?: string;
  requesterRole?: string;
}

const isPeriod = (p: unknown): p is BudgetPeriod => BUDGET_PERIODS.includes(p as BudgetPeriod);
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A pending budget_increase whose window has ended can no longer be approved. */
export function isExpiredRequest(req: ViewRequest, now: Date): boolean {
  if (req.type !== "budget_increase" || req.status !== "pending") return false;
  return !isPeriod(req.period) || typeof req.periodKey !== "string" || !isCurrentPeriodKey(req.period, req.periodKey, now);
}

export type BudgetRequestGate = "expired" | "self" | "admin_required" | "actionable";

/**
 * What the viewer can do with a pending budget_increase. A dept-manager cannot decide
 * a manager's request or one that would exceed the department total (known `dept`);
 * those show "admin approval required".
 */
export function budgetRequestGate(
  req: ViewRequest,
  viewer: ApprovalViewer,
  amount: number,
  dept: DepartmentBudgetState | null,
  now: Date,
): BudgetRequestGate {
  if (isExpiredRequest(req, now)) return "expired";
  if (sameEmail(req.email, viewer.email)) return "self";
  if (!viewer.isAdmin) {
    if (req.requesterRole && req.requesterRole !== "user") return "admin_required";
    if (dept && Number.isFinite(amount) && exceedsDepartment(dept, amount)) return "admin_required";
  }
  return "actionable";
}

/** Pending requests the viewer can act on (sidebar badge). */
export function actionableCount(
  requests: ViewRequest[],
  viewer: ApprovalViewer,
  mode: DeploymentMode,
  now: Date,
): number {
  return requests.filter((r) => {
    if (r.status !== "pending" || r.type === "limit_change") return false;
    if (!isRequestTypeVisible(r.type, mode)) return false;
    if (!viewer.isAdmin && r.type !== "budget_increase") return false;
    if (r.type !== "budget_increase") return !sameEmail(r.email, viewer.email);
    const gate = budgetRequestGate(r, viewer, Number.NaN, null, now);
    return gate === "actionable";
  }).length;
}

/** i18n key for a server error code; unknown codes fall back to `${prefix}.unknown`. */
export function errorKey(prefix: string, code: unknown, known: readonly string[]): string {
  return typeof code === "string" && known.includes(code) ? `${prefix}.${code}` : `${prefix}.unknown`;
}

export const APPROVAL_ERRORS = [
  "self",
  "admin_only_request_type",
  "requester_is_manager",
  "other_department",
  "exceeds_department",
  "expired",
  "invalid_amount",
  "unlimited_period",
  "department_changed_retry",
  "already_decided",
  "retry",
] as const;

export const INCREASE_REQUEST_ERRORS = [
  "pending_exists",
  "unlimited_period",
  "invalid_period",
  "invalid_amount",
  "invalid_reason",
  "invalid_body",
  "retry",
] as const;

export const MEMBER_LIMIT_ERRORS = [
  "self",
  "other_department",
  "target_is_manager",
  "exceeds_department_total",
  "invalid_limit",
  "limit_required",
  "no_department",
  "user_not_found",
] as const;

export interface TokenReleaseResult {
  released: boolean;
  denyCleared?: boolean;
  reason?: string;
  warning?: string;
  noTokenLimit?: boolean;
}

export type ReleaseNotice =
  | { tone: "ok"; tokenCleared: boolean }
  | { tone: "warn"; tokenHeldReason: string }
  | { tone: "warn"; tokenUnknown: true; warning?: string };

/**
 * What the approver sees after an approval. Never just "approved": when a token deny
 * stays (`released: false` with a reason other than no_token_limit) the user is still
 * blocked and the reason is shown; a failed release (no reason) is reported as unknown.
 */
export function releaseNotice(tokenRelease: TokenReleaseResult | undefined): ReleaseNotice {
  if (!tokenRelease || tokenRelease.released) {
    return { tone: "ok", tokenCleared: !!tokenRelease?.denyCleared };
  }
  if (tokenRelease.reason === "no_token_limit") return { tone: "ok", tokenCleared: false };
  if (tokenRelease.reason) return { tone: "warn", tokenHeldReason: tokenRelease.reason };
  return { tone: "warn", tokenUnknown: true, warning: tokenRelease.warning };
}

/** Request form: amount in [1, MAX_INCREASE_USD] USD, reason 1..MAX_REASON_LENGTH after trim. */
export function validIncreaseForm(amount: string, reason: string): boolean {
  const n = Number(amount);
  const r = reason.trim();
  return amount.trim() !== "" && Number.isFinite(n) && n >= 1 && n <= MAX_INCREASE_USD
    && r.length >= 1 && r.length <= MAX_REASON_LENGTH;
}

/** Replace `{name}` placeholders in an i18n template. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Period usage at or above 80% of a set cap (and not yet over it). */
export function nearLimit(spend: number, cap: number): boolean {
  return cap > 0 && spend >= cap * 0.8 && spend < cap;
}
