/**
 * Local Bedrock CLI script issuer (ADR-014).
 *
 * GET: returns a per-user shell script with an embedded bearer token. The
 *      token is randomly generated, SHA-256-hashed, and stored in
 *      cc-on-bedrock-cli-tokens with a TTL. The plain token is only ever
 *      visible in the response body — never persisted server-side.
 *
 * POST: issues a fresh token (rotates existing). Same as GET semantically
 *       but distinguishes the side-effect for client UI ("re-issue").
 *
 * DELETE: revokes a specific token by its hash, or all tokens of this user
 *         when called without a `hash` query param.
 *
 * The script fetches credentials from /api/local/credentials with the
 * embedded token in the Authorization header.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { randomBytes, createHash } from "crypto";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const TABLE = process.env.CLI_TOKENS_TABLE ?? "cc-on-bedrock-cli-tokens";
const TTL_DAYS = Number(process.env.CLI_TOKEN_TTL_DAYS ?? "30");
const TOKEN_PREFIX = "ccb_";

const ddb = new DynamoDBClient({ region });

function generateToken(): string {
  // 32 random bytes, base64url (43 chars), prefixed for recognizability.
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function buildScript(args: {
  dashboardUrl: string;
  token: string;
  region: string;
  username: string;
  department: string;
  ttlDays: number;
  issuedAt: string;
}): string {
  const { dashboardUrl, token, region, username, department, ttlDays, issuedAt } = args;
  return `#!/usr/bin/env bash
# cc-bedrock-login — Local Governance Mode authentication helper (ADR-014)
#
# Issued for : ${username} (${department})
# Issued at  : ${issuedAt}
# Expires in : ${ttlDays} days (token); credentials inside expire in 8h (refresh by re-running)
# Dashboard  : ${dashboardUrl}
#
# WHAT THIS DOES
#   1. Calls the Dashboard to obtain fresh 8h Bedrock STS credentials.
#   2. Writes them as the [\${AWS_PROFILE_NAME}] profile in ~/.aws/credentials.
#   3. Prints the env vars you need to point Claude Code at Bedrock.
#
# SECURITY
#   This file contains a bearer token tied to your Cognito identity. Treat
#   it like an SSH private key: do not commit, share, or paste into chat.
#   Revoke from the Dashboard /user page (Local Bedrock CLI section) if leaked.

set -euo pipefail

DASHBOARD_URL="${dashboardUrl}"
CC_BEDROCK_TOKEN="${token}"
AWS_PROFILE_NAME="\${AWS_PROFILE_NAME:-cc-bedrock}"
AWS_REGION="${region}"

# ── 1. fetch fresh STS creds ────────────────────────────────────────────────
resp="$(curl -fsS -X POST \\
  -H "Authorization: Bearer \${CC_BEDROCK_TOKEN}" \\
  -H "Content-Type: application/json" \\
  "\${DASHBOARD_URL%/}/api/local/credentials" --data '{}')" || {
    echo "✗ Dashboard rejected the token. Re-download from \${DASHBOARD_URL%/}/user" >&2
    exit 1
}

# ── 2. write ~/.aws/credentials ─────────────────────────────────────────────
mkdir -p "\${HOME}/.aws"
touch "\${HOME}/.aws/credentials"
chmod 600 "\${HOME}/.aws/credentials"

python3 - "\${HOME}/.aws/credentials" "\${AWS_PROFILE_NAME}" "\${resp}" <<'PY'
import json, os, re, sys
path, profile, resp = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(resp)
snippet = data["profileSnippet"]
# Rename the snippet section header to match the user-chosen profile.
snippet = re.sub(r"\\[cc-bedrock\\]", f"[{profile}]", snippet, count=1)
content = open(path).read() if os.path.exists(path) else ""
content = re.sub(rf"\\[{re.escape(profile)}\\].*?(?=^\\[|\\Z)", "", content, flags=re.M | re.S).rstrip() + "\\n"
content += "\\n" + snippet.rstrip() + "\\n"
open(path, "w").write(content)
os.chmod(path, 0o600)
PY

# ── 3. show how to use it ───────────────────────────────────────────────────
exp="$(echo "\${resp}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["credentials"]["expiration"])')"

cat <<MSG
✓ Bedrock credentials installed
  profile     : \${AWS_PROFILE_NAME}
  expires     : \${exp}
  user / dept : ${username} / ${department}

To use with Claude Code:
  export CLAUDE_CODE_USE_BEDROCK=1
  export AWS_PROFILE=\${AWS_PROFILE_NAME}
  export AWS_REGION=\${AWS_REGION}
  claude

To refresh (every 8h), just re-run this script.
MSG
`;
}

async function issueToken(session: { user: { id: string; email?: string | null; subdomain?: string; department?: string } }, dashboardUrl: string) {
  const token = generateToken();
  const hash = hashToken(token);
  const issuedAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const username = session.user.subdomain ?? session.user.email ?? session.user.id;
  const department = session.user.department ?? "default";

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      PK: { S: `HASH#${hash}` },
      sub: { S: session.user.id },
      username: { S: username },
      department: { S: department },
      project: { S: "default" },
      issuedAt: { S: issuedAt },
      expiresAt: { N: String(expiresAt) },
    },
  }));

  const script = buildScript({
    dashboardUrl,
    token,
    region,
    username,
    department,
    ttlDays: TTL_DAYS,
    issuedAt,
  });

  return {
    token,
    hash,
    script,
    issuedAt,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    ttlDays: TTL_DAYS,
  };
}

function originOf(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const result = await issueToken(session as Parameters<typeof issueToken>[0], originOf(req));
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const url = new URL(req.url);
  const hash = url.searchParams.get("hash");

  if (hash) {
    // Single revoke
    await ddb.send(new DeleteItemCommand({
      TableName: TABLE,
      Key: { PK: { S: `HASH#${hash}` } },
    }));
    return NextResponse.json({ revoked: 1 });
  }

  // Revoke all of this user's tokens via GSI
  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: "sub-index",
    KeyConditionExpression: "sub = :s",
    ExpressionAttributeValues: { ":s": { S: session.user.id } },
  }));
  let revoked = 0;
  for (const item of q.Items ?? []) {
    const pk = item.PK?.S;
    if (!pk) continue;
    await ddb.send(new DeleteItemCommand({
      TableName: TABLE,
      Key: { PK: { S: pk } },
    }));
    revoked++;
  }
  return NextResponse.json({ revoked });
}
