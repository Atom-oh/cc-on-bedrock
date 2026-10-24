// ADR-031 (B′): release a single user's token-limit deny (cc-bedrock-local-token-deny).
// Reads DENY#active (PK=USER#{email}), detaches the inline policy from the Local role
// named by the ROW's `subdomain` (NOT the email key), then deletes DENY#active.
// The key is the email; the Local role is cc-on-bedrock-local-user-{subdomain}, so the
// two are distinct and must be resolved separately — using the key as the role suffix
// would no-op. Shared by the admin force-reset route and budget-increase approval.

import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { IAMClient, DeleteRolePolicyCommand, NoSuchEntityException } from "@aws-sdk/client-iam";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const LIMITS_TABLE = process.env.LIMITS_TABLE ?? "cc-on-bedrock-limits";
const ROLE_PREFIX = "cc-on-bedrock-local-user-";
const POLICY_NAME = "cc-bedrock-local-token-deny";

const dynamo = new DynamoDBClient({ region });
const iam = new IAMClient({ region });

export const ROLE_UNRESOLVED_WARNING =
  "DENY#active preserved — role unresolved (row missing `subdomain`); IAM deny may still be attached, investigate manually";

export interface TokenDenyRelease {
  released: boolean;
  warning?: string;
  /** Whether a DENY#active row existed. */
  found: boolean;
  role?: string | null;
  detached?: boolean;
}

/** IAM refused the detach (anything but NoSuchEntity); DENY#active is left in place. */
export class TokenDenyDetachError extends Error {
  constructor(roleName: string, cause: unknown) {
    super(`detach failed for ${roleName}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "TokenDenyDetachError";
  }
}

function safeSuffix(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
}

// Mirror limit-reset.py._role_for_item (ADR-031): prefer the row's `subdomain` attr;
// fall back to a non-email PK suffix for legacy rows; an email-keyed row with no
// subdomain attr cannot safely build a role name (returns null).
function roleForRow(key: string, subdomain: string): string | null {
  if (subdomain) return `${ROLE_PREFIX}${subdomain}`;
  if (key && !key.includes("@")) return `${ROLE_PREFIX}${safeSuffix(key)}`; // legacy sub/subdomain key
  return null;
}

/**
 * Detach the token deny and clear DENY#active. No row → `{ released: false, found: false }`.
 * Unresolvable role → DENY#active is preserved with a warning (the IAM deny cannot be
 * detached, and clearing the only tracking record would orphan it). A detach failure
 * other than NoSuchEntity throws `TokenDenyDetachError` ("detach failed for {role}: {message}").
 */
export async function releaseTokenDeny(email: string): Promise<TokenDenyRelease> {
  const key = email.trim().toLowerCase();
  const pk = `USER#${key}`;

  // Read the DENY#active row first — we need its `subdomain` to find the Local role.
  const got = await dynamo.send(new GetItemCommand({
    TableName: LIMITS_TABLE,
    Key: marshall({ PK: pk, SK: "DENY#active" }),
  }));
  if (!got.Item) return { released: false, found: false };

  const item = unmarshall(got.Item);
  const subdomain = (item.subdomain ?? "").toString().trim();
  const roleName = roleForRow(key, subdomain);
  if (!roleName) {
    return { released: false, found: true, role: null, detached: false, warning: ROLE_UNRESOLVED_WARNING };
  }

  let detached = false;
  try {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: POLICY_NAME }));
    detached = true;
  } catch (e) {
    if (!(e instanceof NoSuchEntityException)) {
      throw new TokenDenyDetachError(roleName, e);
    }
    // NoSuchEntity: role or policy already gone — treat as already-detached.
  }

  // Role resolved + detach attempted (or already absent) → safe to clear the DENY#active row.
  await dynamo.send(new DeleteItemCommand({
    TableName: LIMITS_TABLE,
    Key: marshall({ PK: pk, SK: "DENY#active" }),
  }));
  return { released: true, found: true, role: roleName, detached };
}
