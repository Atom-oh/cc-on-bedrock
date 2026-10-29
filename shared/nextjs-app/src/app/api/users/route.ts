import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  listCognitoUsers,
  getCognitoUser,
  createCognitoUser,
  updateCognitoUser,
  deleteCognitoUser,
  disableCognitoUser,
  enableCognitoUser,
  resetUserEnvironment,
} from "@/lib/aws-clients";
import { createUserSchema, updateUserSchema } from "@/lib/validation";
import { batchGetCustomRoutes } from "@/lib/ec2-clients";
import { ROLES, accessRole, requiresRoleGroup, roleFromGroups, validateRoleChange } from "@/lib/roles";
import { countAdmins, getRoleGroups, listGroupMembers, removeUserAccess, requireFreshRole, setUserRole } from "@/lib/role-admin";

/**
 * Shared pool: the dashboard's Cognito IAM reaches every user in the pool, and IAM
 * cannot be scoped by group. A user without a cc role group belongs only to the other
 * app, so cc refuses to disable, enable, edit or delete them; the only allowed action
 * is granting a cc role (ADR-016). Own pool: no restriction.
 */
async function guardForeignUser(username: string): Promise<NextResponse | null> {
  if (!requiresRoleGroup()) return null;
  if (accessRole(await getRoleGroups(username)) !== null) return null;
  return NextResponse.json({ success: false, error: "not_cc_user" }, { status: 403 });
}

/** Refuse disabling yourself or the last enabled admin (same rules as demotion). */
async function guardAdminLoss(actorEmail: string, username: string): Promise<NextResponse | null> {
  const target = await getCognitoUser(username);
  if ((target.email || username).toLowerCase() === actorEmail.toLowerCase()) {
    return NextResponse.json({ success: false, error: "self_demotion" }, { status: 400 });
  }
  const { role } = roleFromGroups(await getRoleGroups(username));
  if (role === "admin" && target.enabled && (await countAdmins()) <= 1) {
    return NextResponse.json({ success: false, error: "last_admin" }, { status: 400 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const fresh = await requireFreshRole(session, ["admin"]);
  if (!fresh.ok) return fresh.response;

  const { searchParams } = new URL(req.url);
  const username = searchParams.get("username");

  try {
    if (username) {
      const user = await getCognitoUser(username);
      return NextResponse.json({ success: true, data: user });
    }
    // Three ListUsersInGroup calls (one per role) instead of a per-user group lookup.
    const [users, ...roleMembers] = await Promise.all([
      listCognitoUsers(),
      ...ROLES.map((r) => listGroupMembers(r)),
    ]);
    const groupsByUser = new Map<string, string[]>();
    ROLES.forEach((role, i) => {
      for (const m of roleMembers[i]) {
        for (const key of [m.username, m.email].filter((k): k is string => !!k).map((k) => k.toLowerCase())) {
          groupsByUser.set(key, [...(groupsByUser.get(key) ?? []), role]);
        }
      }
    });
    // M2: single BatchGetItem instead of N+1 per-user GetItem.
    let routesBySubdomain = new Map<string, { path: string; port: number; label: string }[]>();
    try {
      routesBySubdomain = await batchGetCustomRoutes(
        users.map((u) => u.subdomain).filter(Boolean),
      );
    } catch (err) {
      console.warn("[users] batchGetCustomRoutes failed:", err instanceof Error ? err.message : err);
    }
    const withRoutes = users.map((u) => {
      const groups = [
        ...new Set([
          ...(groupsByUser.get(u.username.toLowerCase()) ?? []),
          ...(groupsByUser.get(u.email.toLowerCase()) ?? []),
        ]),
      ];
      const { needsCleanup } = roleFromGroups(groups);
      return {
        ...u,
        // null = shared pool user without a cc role group (no access until an admin assigns one).
        role: accessRole(groups),
        roleNeedsCleanup: needsCleanup,
        customRoutes: routesBySubdomain.get(u.subdomain) ?? [],
      };
    });
    // requiresRoleGroup: shared pool, the UI offers "No access" (role: null) in the role select.
    return NextResponse.json({ success: true, data: withRoutes, requiresRoleGroup: requiresRoleGroup() });
  } catch (err) {
    console.error("[users] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const fresh = await requireFreshRole(session, ["admin"]);
  if (!fresh.ok) return fresh.response;

  try {
    const raw = await req.json();
    // Empty department for a dept-manager gets the specific error, not the generic min(1) message.
    if (raw?.role === "dept-manager" && typeof raw.department === "string" && !raw.department.trim()) {
      return NextResponse.json({ success: false, error: "dept_required" }, { status: 400 });
    }
    const parsed = createUserSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    const body = parsed.data;
    const roleCheck = validateRoleChange({
      actorEmail: session.user.email ?? "",
      targetEmail: body.email,
      currentRole: "user",
      newRole: body.role,
      targetDepartment: body.department,
      adminCount: 0,
    });
    if (!roleCheck.ok) {
      return NextResponse.json({ success: false, error: roleCheck.error }, { status: 400 });
    }
    const cognitoUser = await createCognitoUser(body);
    return NextResponse.json({ success: true, data: cognitoUser });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[users] POST", message);
    const isUserExists = message.includes("already exists") || message.includes("UsernameExists");
    return NextResponse.json(
      { success: false, error: isUserExists ? "User account already exists" : message },
      { status: isUserExists ? 409 : 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const fresh = await requireFreshRole(session, ["admin"]);
  if (!fresh.ok) return fresh.response;

  try {
    const raw = await req.json();

    // Handle enable/disable action
    if (raw.action === "enable" || raw.action === "disable") {
      if (!raw.username) {
        return NextResponse.json({ success: false, error: "username is required" }, { status: 400 });
      }
      const foreign = await guardForeignUser(raw.username);
      if (foreign) return foreign;
      if (raw.action === "enable") await enableCognitoUser(raw.username);
      else {
        const blocked = await guardAdminLoss(session.user.email ?? "", raw.username);
        if (blocked) return blocked;
        await disableCognitoUser(raw.username);
      }
      return NextResponse.json({ success: true });
    }

    // Shared pool "No access": role null / "none" removes every cc role group.
    if (raw.role === null || raw.role === "none") {
      if (!requiresRoleGroup()) {
        return NextResponse.json({ success: false, error: "role must be admin, dept-manager or user" }, { status: 400 });
      }
      if (!raw.username || typeof raw.username !== "string") {
        return NextResponse.json({ success: false, error: "username is required" }, { status: 400 });
      }
      if (Object.keys(raw).some((k) => k !== "username" && k !== "role")) {
        return NextResponse.json({ success: false, error: "Removing access cannot be combined with other changes" }, { status: 400 });
      }
      // Another app's user has no cc group to remove; never sign them out of that app.
      const foreign = await guardForeignUser(raw.username);
      if (foreign) return foreign;
      // Same guards as disabling: never yourself, never the last enabled admin.
      const blocked = await guardAdminLoss(session.user.email ?? "", raw.username);
      if (blocked) return blocked;
      try {
        await removeUserAccess(raw.username);
      } catch (err) {
        console.error("[users] PUT removeUserAccess", err instanceof Error ? err.message : err);
        return NextResponse.json({ success: false, error: "role_change_failed" }, { status: 500 });
      }
      return NextResponse.json({ success: true, data: { roleChanged: true } });
    }

    // Handle attribute update
    const parsed = updateUserSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { role: requestedRole, ...attrs } = parsed.data;
    // A no-access shared-pool user may only be granted a role (with optional attributes).
    if (!requestedRole) {
      const foreign = await guardForeignUser(attrs.username);
      if (foreign) return foreign;
    }
    let roleChanged = false;
    let attrsWritten = false;
    if (requestedRole || attrs.department) {
      const currentGroups = await getRoleGroups(attrs.username);
      const current = roleFromGroups(currentGroups);
      // Shared pool: a user without a cc role group must get the group even when "user" is picked.
      const noAccess = accessRole(currentGroups) === null;
      const newRole = requestedRole ?? current.role;
      const target = await getCognitoUser(attrs.username);
      const check = validateRoleChange({
        actorEmail: session.user.email ?? "",
        targetEmail: target.email || attrs.username,
        currentRole: current.role,
        newRole,
        // Validate against the NEW department when one is sent together with the role.
        targetDepartment: attrs.department ?? target.department,
        adminCount: await countAdmins(),
        targetEnabled: target.enabled,
      });
      if (!check.ok) {
        return NextResponse.json({ success: false, error: check.error }, { status: 400 });
      }
      // Department first: if the role write then fails, the user is never a
      // dept-manager of the department they were just moved out of. Granting access
      // to another app's user is the exception: the group goes first, so a failed
      // grant never leaves cc-written attributes on a user cc does not manage.
      if (noAccess && requestedRole) {
        try {
          await setUserRole(attrs.username, requestedRole);
        } catch (err) {
          console.error("[users] PUT setUserRole", err instanceof Error ? err.message : err);
          return NextResponse.json({ success: false, error: "role_change_failed" }, { status: 500 });
        }
        roleChanged = true;
      }
      await updateCognitoUser(attrs);
      attrsWritten = true;
      // Also re-apply when the user holds several role groups, so the change normalizes them.
      if (!roleChanged && requestedRole && (requestedRole !== current.role || current.needsCleanup)) {
        try {
          await setUserRole(attrs.username, requestedRole);
        } catch (err) {
          // The user may now hold both groups; surface failure so the UI never shows success.
          console.error("[users] PUT setUserRole", err instanceof Error ? err.message : err);
          return NextResponse.json({ success: false, error: "role_change_failed" }, { status: 500 });
        }
        roleChanged = true;
      }
    }
    if (!attrsWritten) await updateCognitoUser(attrs);
    return NextResponse.json({ success: true, data: { roleChanged } });
  } catch (err) {
    console.error("[users] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const fresh = await requireFreshRole(session, ["admin"]);
  if (!fresh.ok) return fresh.response;

  const { searchParams } = new URL(req.url);
  const username = searchParams.get("username");
  const action = searchParams.get("action");

  if (!username) {
    return NextResponse.json({ error: "Username required" }, { status: 400 });
  }

  try {
    const foreign = await guardForeignUser(username);
    if (foreign) return foreign;
    switch (action) {
      case "disable": {
        const blocked = await guardAdminLoss(session.user.email ?? "", username);
        if (blocked) return blocked;
        await disableCognitoUser(username);
        return NextResponse.json({ success: true });
      }
      case "enable":
        await enableCognitoUser(username);
        return NextResponse.json({ success: true });
      case "permanent":
        // ADR-024: Cognito users may be federated from an external IdP (SAML/OIDC)
        // where the source-of-truth identity lives elsewhere. Deleting from Cognito
        // breaks resyncability and the downstream cleanup is destructive. The
        // dashboard exposes `disable` instead; permanent deletion must go through
        // the AWS Console / CLI by a human with full context, which then fires
        // AdminDeleteUser → user-role-provisioner for downstream cleanup.
        //
        // 403 (not 405): the DELETE method itself is allowed — we're rejecting
        // the `action=permanent` value as a policy decision, not an HTTP method
        // mismatch. 405 would require an Allow header listing valid methods,
        // which doesn't describe this case.
        return NextResponse.json(
          {
            success: false,
            error:
              "Permanent delete is disabled from the dashboard. Use Disable to revoke access. " +
              "Hard-delete a Cognito user via the AWS Console / CLI only after confirming " +
              "they are not federated from an external IdP.",
          },
          { status: 403 }
        );
      default: {
        // Soft-delete: keep Cognito user, remove environment
        const user = await getCognitoUser(username);
        if (!user.subdomain) {
          return NextResponse.json({ success: true, data: { message: "No environment to reset" } });
        }
        const result = await resetUserEnvironment(username, user.subdomain);
        return NextResponse.json({ success: true, data: result });
      }
    }
  } catch (err) {
    console.error("[users] DELETE", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
