import {
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { NextResponse } from "next/server";
import { cognitoClient, userPoolId } from "./aws-clients";
import { accessRole, groupName, requiresRoleGroup, rolesFromGroupNames, type Role } from "./roles";
import { deriveSubdomain } from "./utils";

const MAX_PAGES = 100;

type Send = (command: unknown) => Promise<unknown>;
const defaultSend: Send = (command) =>
  (cognitoClient.send as (c: unknown) => Promise<unknown>)(command);

/** Whether the Cognito user is enabled (a disabled user keeps its groups). */
export async function getUserEnabled(username: string): Promise<boolean> {
  const res = (await defaultSend(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }))) as {
    Enabled?: boolean;
  };
  return res.Enabled !== false;
}

/** Roles (admin / dept-manager / user) the user currently holds, prefix stripped; other apps' groups ignored. */
export async function getRoleGroups(username: string): Promise<Role[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const res = await cognitoClient.send(
      new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username, NextToken: nextToken })
    );
    names.push(...(res.Groups ?? []).map((g) => g.GroupName ?? ""));
    nextToken = res.NextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES);
  return rolesFromGroupNames(names);
}

/**
 * Make `role` the user's only role group: add the new group first (never leave
 * the user role-less), remove the other role groups, then revoke tokens so the
 * stale session groups stop working.
 */
export async function setUserRole(
  username: string,
  role: Role,
  send: Send = defaultSend,
  fetchGroups: (username: string) => Promise<string[]> = getRoleGroups
): Promise<void> {
  const current = await fetchGroups(username);
  await send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: groupName(role) }));
  for (const g of current.filter((g) => g !== role)) {
    await send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: groupName(g as Role) }));
  }
  await send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: username }));
}

/** All members of one role group (paginated). */
export async function listGroupMembers(
  group: Role
): Promise<{ username: string; email?: string; enabled: boolean }[]> {
  const members: { username: string; email?: string; enabled: boolean }[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const res = await cognitoClient.send(
      new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: groupName(group), NextToken: nextToken })
    );
    for (const u of res.Users ?? []) {
      members.push({
        username: u.Username ?? "",
        email: u.Attributes?.find((a) => a.Name === "email")?.Value,
        enabled: u.Enabled !== false,
      });
    }
    nextToken = res.NextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES);
  return members;
}

/** Enabled admins only: a disabled admin cannot act, so it must not satisfy the last-admin guard. */
export async function countAdmins(): Promise<number> {
  return (await listGroupMembers("admin")).filter((m) => m.enabled).length;
}

/** Re-check the caller's CURRENT Cognito role (sessions last 8h and carry stale groups). */
export async function requireFreshRole(
  session: { user?: { email?: string | null } } | null | undefined,
  allowed: Role[],
  getGroups: (username: string) => Promise<string[]> = getRoleGroups,
  getEnabled: (username: string) => Promise<boolean> = getUserEnabled
): Promise<{ ok: true; role: Role } | { ok: false; response: NextResponse }> {
  const email = session?.user?.email;
  if (!email) {
    return { ok: false, response: NextResponse.json({ error: "Role changed — sign in again" }, { status: 403 }) };
  }
  let groups: string[];
  let enabled: boolean;
  try {
    // A disabled user keeps its groups and its 8h session JWT, so both are checked.
    [groups, enabled] = await Promise.all([getGroups(email), getEnabled(email)]);
  } catch (err) {
    console.error("[requireFreshRole] Cognito group lookup failed:", err);
    return { ok: false, response: NextResponse.json({ error: "Role check unavailable" }, { status: 503 }) };
  }
  // Shared pool: no cc role group = no access (accessRole null), same 403 as a role change.
  const role = accessRole(groups);
  if (!enabled || role === null || !allowed.includes(role)) {
    return { ok: false, response: NextResponse.json({ error: "Role changed — sign in again" }, { status: 403 }) };
  }
  return { ok: true, role };
}

/**
 * Gate for paths without a role requirement (e.g. /api/local/credentials). Both pools:
 * the Cognito user must be enabled (a disabled user keeps its groups and tokens).
 * Shared pool only: the user must also hold SOME cc role group. Both read fresh from
 * Cognito and fail closed: lookup error 503, no username / disabled / no role group 403.
 */
export async function requireAnyRoleGroup(
  username: string | undefined,
  getGroups: (username: string) => Promise<string[]> = getRoleGroups,
  getEnabled: (username: string) => Promise<boolean> = getUserEnabled,
  prefix?: string
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const denied = { ok: false as const, response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  if (!username) return denied;
  const shared = requiresRoleGroup(prefix);
  let groups: string[] = [];
  let enabled: boolean;
  try {
    [groups, enabled] = await Promise.all([shared ? getGroups(username) : Promise.resolve([]), getEnabled(username)]);
  } catch (err) {
    console.error("[requireAnyRoleGroup] Cognito lookup failed:", err);
    return { ok: false, response: NextResponse.json({ error: "Role check unavailable" }, { status: 503 }) };
  }
  if (!enabled) return denied;
  if (shared && accessRole(groups, prefix) === null) return denied;
  return { ok: true };
}

/**
 * Shared pool "No access": remove the user from every cc role group it holds, then
 * revoke tokens so the stale session groups stop working. Guards live in the caller.
 */
export async function removeUserAccess(
  username: string,
  send: Send = defaultSend,
  fetchGroups: (username: string) => Promise<string[]> = getRoleGroups
): Promise<void> {
  for (const g of await fetchGroups(username)) {
    await send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: groupName(g as Role) }));
  }
  await send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: username }));
}

/**
 * Shared pool (ADR-016): the user's Local role is pinned to `custom:subdomain`, which only
 * Admin* APIs can write. Returns the pinned value, pinning it from the current email on
 * first use. sts-issuer's ensure_role refuses a role whose owner email differs, so a later
 * self-service email change cannot mint a fresh role (and a fresh budget identity).
 * Read fresh from Cognito, never from the session. Throws on lookup/write failure.
 */
export async function pinnedSubdomain(username: string, send: Send = defaultSend): Promise<string> {
  const res = (await send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }))) as {
    UserAttributes?: { Name?: string; Value?: string }[];
  };
  const attrs = Object.fromEntries((res.UserAttributes ?? []).map((a) => [a.Name ?? "", a.Value ?? ""]));
  if (attrs["custom:subdomain"]) return attrs["custom:subdomain"];
  // The first pin names the role after the email, so it must be a verified address.
  if (attrs["email_verified"] !== "true") throw new Error("email not verified; refusing to pin a subdomain");
  const derived = deriveSubdomain(attrs["email"] ?? "");
  if (!derived) throw new Error("cannot derive a subdomain from the user's email");
  await send(new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId,
    Username: username,
    UserAttributes: [{ Name: "custom:subdomain", Value: derived }],
  }));
  return derived;
}
