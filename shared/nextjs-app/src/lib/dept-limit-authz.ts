/**
 * Standing per-user limits (daily / weekly / monthly USD) set by an admin or by a
 * dept-manager for members of their own department. Pure, dependency-free rules so
 * they are unit-testable without the route's AWS imports.
 *
 * Callers pass FRESH identity: the actor's role and department and the target's
 * department are read from Cognito, never from the (up to 8h stale) session.
 */
import { hasRealDepartment, type Role } from "./roles";

/** Upper bound for one period's standing limit (USD). 0 = inherit. */
export const MAX_STANDING_LIMIT_USD = 100000;

export const MEMBER_LIMIT_FIELDS = ["dailyBudget", "weeklyBudget", "monthlyBudget"] as const;
export type MemberLimitField = (typeof MEMBER_LIMIT_FIELDS)[number];
export type MemberLimits = Partial<Record<MemberLimitField, number>>;

export type MemberLimitError = "self" | "other_department" | "exceeds_department_total" | "not_manager";

export function canSetMemberLimit(i: {
  actor: { email: string; role: Role; department?: string };
  target: { email: string; department: string };
  monthlyBudget?: number;
  deptMonthlyBudget: number;
}): { ok: true } | { ok: false; error: MemberLimitError } {
  // Admin changes are always allowed (own limits included); the route audits them.
  if (i.actor.role === "admin") return { ok: true };
  if (i.actor.role !== "dept-manager") return { ok: false, error: "not_manager" };

  // Fail closed: a missing identity on either side counts as "self".
  const actorEmail = i.actor.email.trim().toLowerCase();
  const targetEmail = i.target.email.trim().toLowerCase();
  if (actorEmail === "" || targetEmail === "" || actorEmail === targetEmail) {
    return { ok: false, error: "self" };
  }

  // Both departments must be real (not blank / "default") and equal.
  const actorDept = i.actor.department ?? "";
  if (!hasRealDepartment(actorDept) || !hasRealDepartment(i.target.department) || actorDept !== i.target.department) {
    return { ok: false, error: "other_department" };
  }

  // A set department total (> 0) caps any member's monthly limit; 0 = no total.
  if (i.monthlyBudget !== undefined && i.deptMonthlyBudget > 0 && i.monthlyBudget > i.deptMonthlyBudget) {
    return { ok: false, error: "exceeds_department_total" };
  }
  return { ok: true };
}

/** PUT body validation: each provided period is a finite USD value in [0, MAX_STANDING_LIMIT_USD]. */
export function validateMemberLimits(
  body: Record<string, unknown>
): { ok: true; limits: MemberLimits } | { ok: false; error: "invalid_limit" | "limit_required" } {
  const limits: MemberLimits = {};
  for (const f of MEMBER_LIMIT_FIELDS) {
    const v = body[f];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_STANDING_LIMIT_USD) {
      return { ok: false, error: "invalid_limit" };
    }
    limits[f] = v;
  }
  if (Object.keys(limits).length === 0) return { ok: false, error: "limit_required" };
  return { ok: true, limits };
}
