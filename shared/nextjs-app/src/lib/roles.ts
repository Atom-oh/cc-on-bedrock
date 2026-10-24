// Pure role rules. The Cognito group is the single source of a user's role.
export const ROLES = ["admin", "dept-manager", "user"] as const;
export type Role = (typeof ROLES)[number];

/** Highest-privilege role among the groups (admin > dept-manager > user). */
export function roleFromGroups(groups: string[]): { role: Role; needsCleanup: boolean } {
  const held = ROLES.filter((r) => groups.includes(r));
  if (held.length === 0) return { role: "user", needsCleanup: false };
  return { role: held[0], needsCleanup: held.length > 1 };
}

export type RoleChangeError = "self_demotion" | "last_admin" | "dept_required";

export function validateRoleChange(i: {
  actorEmail: string;
  targetEmail: string;
  currentRole: Role;
  newRole: Role;
  targetDepartment: string;
  adminCount: number;
}): { ok: true } | { ok: false; error: RoleChangeError } {
  const demotingAdmin = i.currentRole === "admin" && i.newRole !== "admin";
  if (demotingAdmin && i.actorEmail.toLowerCase() === i.targetEmail.toLowerCase()) {
    return { ok: false, error: "self_demotion" };
  }
  if (demotingAdmin && i.adminCount <= 1) {
    return { ok: false, error: "last_admin" };
  }
  if (i.newRole === "dept-manager" && !i.targetDepartment.trim()) {
    return { ok: false, error: "dept_required" };
  }
  return { ok: true };
}
