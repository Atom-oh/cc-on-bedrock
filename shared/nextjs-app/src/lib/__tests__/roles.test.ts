import { describe, it, expect, vi, afterEach } from "vitest";
import { accessRole, groupName, groupPrefix, requiresRoleGroup, roleFromGroups, rolesFromGroupNames, validateRoleChange } from "../roles";
import { removeUserAccess, requireAnyRoleGroup, requireFreshRole, setUserRole } from "../role-admin";
import { rolesFromIdToken, signInAllowed } from "../auth";

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
    const r = await requireFreshRole(session, ["admin"], async () => ["user"], async () => true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toEqual({ error: "Role changed — sign in again" });
    }
  });
  it("ok when current role is allowed", async () => {
    expect(await requireFreshRole(session, ["admin"], async () => ["admin"], async () => true)).toEqual({ ok: true, role: "admin" });
  });
  it("403 without session email", async () => {
    const r = await requireFreshRole({ user: {} }, ["admin"], async () => ["admin"], async () => true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });
  it("403 for a disabled user who still holds the role group", async () => {
    const r = await requireFreshRole(session, ["admin"], async () => ["admin"], async () => false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });
  it("fails closed with 503 when the enabled lookup throws", async () => {
    const r = await requireFreshRole(session, ["admin"], async () => ["admin"], async () => { throw new Error("x"); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(503);
  });
  it("fails closed with 503 when lookup throws", async () => {
    const r = await requireFreshRole(session, ["admin"], async () => { throw new Error("boom"); }, async () => true);
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

describe("group prefix (shared user pool)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads COGNITO_GROUP_PREFIX, unset = own pool", () => {
    vi.stubEnv("COGNITO_GROUP_PREFIX", "cc-");
    expect(groupPrefix()).toBe("cc-");
    expect(groupName("dept-manager")).toBe("cc-dept-manager");
    expect(requiresRoleGroup()).toBe(true);
    vi.unstubAllEnvs();
    delete process.env.COGNITO_GROUP_PREFIX;
    expect(groupPrefix()).toBe("");
    expect(groupName("admin")).toBe("admin");
    expect(requiresRoleGroup()).toBe(false);
  });

  it("strips the prefix and ignores other apps' groups", () => {
    expect(rolesFromGroupNames(["admins", "ccdash-admin", "cc-user", "admin", "user"], "cc-")).toEqual(["user"]);
    expect(rolesFromGroupNames(["cc-admin", "cc-dept-manager"], "cc-")).toEqual(["admin", "dept-manager"]);
    expect(rolesFromGroupNames(["admins", "ccdash-admin"], "cc-")).toEqual([]);
  });

  it("own pool keeps exact role names", () => {
    expect(rolesFromGroupNames(["admin", "other", "cc-user"], "")).toEqual(["admin"]);
  });

  it("accessRole: no role group = null in a shared pool, user in the own pool", () => {
    expect(accessRole([], "cc-")).toBeNull();
    expect(accessRole(["dept-manager"], "cc-")).toBe("dept-manager");
    expect(accessRole([], "")).toBe("user");
  });
});

describe("sign-in gate helpers", () => {
  const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64")}.s`;
  it("rolesFromIdToken normalizes cognito:groups", () => {
    expect(rolesFromIdToken(jwt({ "cognito:groups": ["admins", "cc-admin"] }), "cc-")).toEqual(["admin"]);
    expect(rolesFromIdToken(jwt({}), "cc-")).toEqual([]);
    expect(rolesFromIdToken("not-a-jwt", "cc-")).toEqual([]);
    expect(rolesFromIdToken(undefined, "")).toEqual([]);
  });
  it("signInAllowed refuses no-group users only in a shared pool", () => {
    expect(signInAllowed([], "cc-")).toBe(false);
    expect(signInAllowed(["user"], "cc-")).toBe(true);
    expect(signInAllowed([], "")).toBe(true);
  });
});

describe("requireFreshRole with a group prefix", () => {
  const session = { user: { email: "a@x.com" } };
  afterEach(() => vi.unstubAllEnvs());
  it("shared pool: no cc role group → 403 (same response as a role change)", async () => {
    vi.stubEnv("COGNITO_GROUP_PREFIX", "cc-");
    const r = await requireFreshRole(session, ["user", "dept-manager", "admin"], async () => [], async () => true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toEqual({ error: "Role changed — sign in again" });
    }
  });
  it("own pool: no role group still resolves to user", async () => {
    vi.stubEnv("COGNITO_GROUP_PREFIX", "");
    expect(await requireFreshRole(session, ["user"], async () => [], async () => true)).toEqual({ ok: true, role: "user" });
  });
});

describe("requireAnyRoleGroup (local credentials gate)", () => {
  const on = async () => true;
  const off = async () => false;
  it("own pool: checks enabled only, no group lookup", async () => {
    const getGroups = vi.fn();
    expect(await requireAnyRoleGroup("a@x.com", getGroups, on, "")).toEqual({ ok: true });
    expect(getGroups).not.toHaveBeenCalled();
  });
  it("shared pool: ok with a cc role group", async () => {
    expect(await requireAnyRoleGroup("a@x.com", async () => ["user"], on, "cc-")).toEqual({ ok: true });
  });
  it("403 without a role group (shared), when disabled (both pools), or without a username", async () => {
    for (const r of [
      await requireAnyRoleGroup("a@x.com", async () => [], on, "cc-"),
      await requireAnyRoleGroup("a@x.com", async () => ["admin"], off, "cc-"),
      await requireAnyRoleGroup("a@x.com", async () => [], off, ""),
      await requireAnyRoleGroup(undefined, async () => ["admin"], on, "cc-"),
      await requireAnyRoleGroup(undefined, async () => [], on, ""),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(403);
        expect(await r.response.json()).toEqual({ error: "Access denied" });
      }
    }
  });
  it("fails closed with 503 when a lookup throws", async () => {
    const boom = async () => { throw new Error("x"); };
    for (const r of [
      await requireAnyRoleGroup("a@x.com", boom, on, "cc-"),
      await requireAnyRoleGroup("a@x.com", async () => ["user"], boom, "cc-"),
      await requireAnyRoleGroup("a@x.com", async () => [], boom, ""),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(503);
    }
  });
});

describe("removeUserAccess", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("removes every held cc role group (prefixed), then signs out", async () => {
    vi.stubEnv("COGNITO_GROUP_PREFIX", "cc-");
    const calls: string[] = [];
    const send = async (c: unknown) => {
      const cmd = c as { constructor: { name: string }; input: { GroupName?: string } };
      calls.push(`${cmd.constructor.name}:${cmd.input.GroupName ?? ""}`);
      return {};
    };
    await removeUserAccess("a@x.com", send, async () => ["admin", "user"]);
    expect(calls).toEqual([
      "AdminRemoveUserFromGroupCommand:cc-admin",
      "AdminRemoveUserFromGroupCommand:cc-user",
      "AdminUserGlobalSignOutCommand:",
    ]);
  });
});

describe("setUserRole with a group prefix", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses the prefixed Cognito group names", async () => {
    vi.stubEnv("COGNITO_GROUP_PREFIX", "cc-");
    const calls: string[] = [];
    const send = async (c: unknown) => {
      const cmd = c as { constructor: { name: string }; input: { GroupName?: string } };
      calls.push(`${cmd.constructor.name}:${cmd.input.GroupName ?? ""}`);
      return {};
    };
    await setUserRole("a@x.com", "dept-manager", send, async () => ["user"]);
    expect(calls).toEqual([
      "AdminAddUserToGroupCommand:cc-dept-manager",
      "AdminRemoveUserFromGroupCommand:cc-user",
      "AdminUserGlobalSignOutCommand:",
    ]);
  });
});
