import { describe, it, expect } from "vitest";
import { roleFromGroups, validateRoleChange } from "../roles";
import { requireFreshRole, setUserRole } from "../role-admin";

describe("roleFromGroups", () => {
  it("defaults to user with no role groups", () => {
    expect(roleFromGroups([])).toEqual({ role: "user", needsCleanup: false });
  });
  it("picks the highest role and flags cleanup", () => {
    expect(roleFromGroups(["user", "admin"])).toEqual({ role: "admin", needsCleanup: true });
  });
  it("ignores non-role groups", () => {
    expect(roleFromGroups(["dept-manager", "other"])).toEqual({ role: "dept-manager", needsCleanup: false });
  });
});

describe("validateRoleChange", () => {
  const base = {
    actorEmail: "a@x.com",
    targetEmail: "b@x.com",
    currentRole: "user" as const,
    newRole: "user" as const,
    targetDepartment: "eng",
    adminCount: 2,
  };
  it("blocks self demotion (case-insensitive)", () => {
    expect(validateRoleChange({ ...base, actorEmail: "A@X.com", targetEmail: "a@x.com", currentRole: "admin" }))
      .toEqual({ ok: false, error: "self_demotion" });
  });
  it("blocks demoting the last admin", () => {
    expect(validateRoleChange({ ...base, currentRole: "admin", adminCount: 1 }))
      .toEqual({ ok: false, error: "last_admin" });
  });
  it("requires a department for dept-manager", () => {
    expect(validateRoleChange({ ...base, newRole: "dept-manager", targetDepartment: "" }))
      .toEqual({ ok: false, error: "dept_required" });
  });
  it("treats the placeholder department 'default' as no department", () => {
    for (const d of ["default", " Default ", "  ", "all", "ALL"]) {
      expect(validateRoleChange({ ...base, newRole: "dept-manager", targetDepartment: d }))
        .toEqual({ ok: false, error: "dept_required" });
    }
  });
  it("does not apply the last-admin guard to a disabled admin target", () => {
    expect(validateRoleChange({ ...base, currentRole: "admin", adminCount: 1, targetEnabled: false }))
      .toEqual({ ok: true });
  });
  it("allows a normal change", () => {
    expect(validateRoleChange({ ...base, currentRole: "admin", newRole: "dept-manager" })).toEqual({ ok: true });
  });
});

describe("requireFreshRole", () => {
  const session = { user: { email: "a@x.com" } };
  it("403 when current role is not allowed", async () => {
    const r = await requireFreshRole(session, ["admin"], async () => ["user"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toEqual({ error: "Role changed — sign in again" });
    }
  });
  it("ok when current role is allowed", async () => {
    expect(await requireFreshRole(session, ["admin"], async () => ["admin"])).toEqual({ ok: true, role: "admin" });
  });
  it("403 without session email", async () => {
    const r = await requireFreshRole({ user: {} }, ["admin"], async () => ["admin"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });
  it("fails closed with 503 when lookup throws", async () => {
    const r = await requireFreshRole(session, ["admin"], async () => { throw new Error("boom"); });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(503);
      expect(await r.response.json()).toEqual({ error: "Role check unavailable" });
    }
  });
});

describe("setUserRole call order", () => {
  it("adds new group, removes the others, then signs out", async () => {
    const calls: string[] = [];
    const send = async (c: unknown) => {
      const cmd = c as { constructor: { name: string }; input: { GroupName?: string } };
      calls.push(`${cmd.constructor.name}:${cmd.input.GroupName ?? ""}`);
      return {};
    };
    await setUserRole("a@x.com", "admin", send, async () => ["user", "dept-manager", "admin"]);
    expect(calls).toEqual([
      "AdminAddUserToGroupCommand:admin",
      "AdminRemoveUserFromGroupCommand:user",
      "AdminRemoveUserFromGroupCommand:dept-manager",
      "AdminUserGlobalSignOutCommand:",
    ]);
  });
});
