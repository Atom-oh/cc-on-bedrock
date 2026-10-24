// Pure route gating used by src/middleware.ts (role from the session token groups).
// Every /api/admin* and /admin* path is admin-only, except APPROVER_PATHS which a
// dept-manager may also reach; the route handlers re-check the fresh Cognito role.

export const ADMIN_PATHS = [
  "/api/containers",
  "/api/users",
  "/api/container-metrics",
  "/api/security",
  "/api/admin",
  "/admin",
  "/monitoring",
];
export const APPROVER_PATHS = ["/api/admin/approval-requests", "/admin/approvals"];
export const DEPT_PATHS = ["/api/dept", "/dept"];

// Exact path or a sub-path; a bare prefix match would also admit e.g. "/admin/approvalsx".
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

export function isAllowedPath(path: string, groups: string[]): boolean {
  const isAdmin = groups.includes("admin");
  const isMgr = groups.includes("dept-manager");
  if (ADMIN_PATHS.some((p) => path.startsWith(p))) {
    return isAdmin || (isMgr && APPROVER_PATHS.some((p) => under(path, p)));
  }
  if (DEPT_PATHS.some((p) => path.startsWith(p))) return isAdmin || isMgr;
  return true;
}
