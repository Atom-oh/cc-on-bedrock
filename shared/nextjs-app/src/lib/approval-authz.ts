/**
 * ADR-026 T7 — approval authorization (pure, dependency-free so it is unit-testable
 * without loading the Next route's server/AWS imports).
 *
 * Admin may approve any request. A dept-manager may approve ONLY requests whose
 * STORED department equals their own — the route reads the request from DynamoDB
 * and passes that stored value here, never a client-supplied one.
 */
export interface ApproverUser {
  isAdmin: boolean;
  groups?: string[];
  department?: string;
}

export function isApprover(user: ApproverUser): boolean {
  return !!user.isAdmin || (user.groups ?? []).includes("dept-manager");
}

export function canApproveRequest(user: ApproverUser, requestDepartment: string): boolean {
  if (user.isAdmin) return true;
  const isDeptMgr = (user.groups ?? []).includes("dept-manager");
  return isDeptMgr && !!user.department && user.department === requestDepartment;
}
