// Pure role rules. The Cognito group is the single source of a user's role.
export const ROLES = ["admin", "dept-manager", "user"] as const;
export type Role = (typeof ROLES)[number];

// Shared user pool (pool also used by other apps): cc's role groups carry a prefix
// (e.g. "cc-admin") so they never collide with another app's groups. Empty prefix =
// cc's own pool, groups named exactly as the roles. App logic only ever sees the
// stripped Role names; the prefix is applied/removed at the Cognito boundary.

/** COGNITO_GROUP_PREFIX ("" or unset = own pool). Read per call so tests can stub env. */
export function groupPrefix(): string {
  return process.env.COGNITO_GROUP_PREFIX ?? "";
}

/** Cognito GroupName of a role. */
export function groupName(role: Role, prefix: string = groupPrefix()): string {
  return prefix + role;
}

/** cc roles among raw Cognito group names; other apps' groups are ignored. */
export function rolesFromGroupNames(raw: string[], prefix: string = groupPrefix()): Role[] {
  return ROLES.filter((r) => raw.includes(prefix + r));
}

/** Shared pool: a user without a cc role group has no access (no default "user"). */
export function requiresRoleGroup(prefix: string = groupPrefix()): boolean {
  return prefix !== "";
}

/**
 * Role that grants access, or null for no access. `groups` are stripped Role names.
 * Own pool: no role group = "user" (roleFromGroups). Shared pool: no role group = null.
 */
export function accessRole(groups: string[], prefix: string = groupPrefix()): Role | null {
  if (requiresRoleGroup(prefix) && !ROLES.some((r) => groups.includes(r))) return null;
  return roleFromGroups(groups).role;
}

/** Highest-privilege role among the groups (admin > dept-manager > user). */
export function roleFromGroups(groups: string[]): { role: Role; needsCleanup: boolean } {
  const held = ROLES.filter((r) => groups.includes(r));
  if (held.length === 0) return { role: "user", needsCleanup: false };
  return { role: held[0], needsCleanup: held.length > 1 };
}

export type RoleChangeError = "self_demotion" | "last_admin" | "dept_required";

/** Blank or the placeholder "default" is not a real department. */
export function hasRealDepartment(department: string): boolean {
  const d = department.trim().toLowerCase();
  // "all" is reserved: /api/dept treats it as the every-department aggregate.
  return d !== "" && d !== "default" && d !== "all";
}

export function validateRoleChange(i: {
  actorEmail: string;
  targetEmail: string;
  currentRole: Role;
  newRole: Role;
  targetDepartment: string;
  adminCount: number;
  /** Whether the target is enabled (default true); a disabled admin does not count toward the last-admin guard. */
  targetEnabled?: boolean;
}): { ok: true } | { ok: false; error: RoleChangeError } {
  const demotingAdmin = i.currentRole === "admin" && i.newRole !== "admin";
  if (demotingAdmin && i.actorEmail.toLowerCase() === i.targetEmail.toLowerCase()) {
    return { ok: false, error: "self_demotion" };
  }
  if (demotingAdmin && (i.targetEnabled ?? true) && i.adminCount <= 1) {
    return { ok: false, error: "last_admin" };
  }
  if (i.newRole === "dept-manager" && !hasRealDepartment(i.targetDepartment)) {
    return { ok: false, error: "dept_required" };
  }
  return { ok: true };
}
