import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { NextResponse } from "next/server";
import { cognitoClient, userPoolId } from "./aws-clients";
import { ROLES, roleFromGroups, type Role } from "./roles";

const MAX_PAGES = 100;

type Send = (command: unknown) => Promise<unknown>;
const defaultSend: Send = (command) =>
  (cognitoClient.send as (c: unknown) => Promise<unknown>)(command);

/** Role groups (admin / dept-manager / user) the user is currently in. */
export async function getRoleGroups(username: string): Promise<string[]> {
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
  return names.filter((n): n is Role => (ROLES as readonly string[]).includes(n));
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
  await send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: role }));
  for (const g of current.filter((g) => g !== role)) {
    await send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: g }));
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
      new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: group, NextToken: nextToken })
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
  getGroups: (username: string) => Promise<string[]> = getRoleGroups
): Promise<{ ok: true; role: Role } | { ok: false; response: NextResponse }> {
  const email = session?.user?.email;
  if (!email) {
    return { ok: false, response: NextResponse.json({ error: "Role changed — sign in again" }, { status: 403 }) };
  }
  let groups: string[];
  try {
    groups = await getGroups(email);
  } catch (err) {
    console.error("[requireFreshRole] Cognito group lookup failed:", err);
    return { ok: false, response: NextResponse.json({ error: "Role check unavailable" }, { status: 503 }) };
  }
  const { role } = roleFromGroups(groups);
  if (!allowed.includes(role)) {
    return { ok: false, response: NextResponse.json({ error: "Role changed — sign in again" }, { status: 403 }) };
  }
  return { ok: true, role };
}
