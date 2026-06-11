import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "crypto";
import { IAM_POLICY_SETS } from "@/lib/ec2-clients";
import {
  buildIamExtensionRequest,
  DEFAULT_SERVICE_ALLOWLIST,
  DEFAULT_WILDCARD_OK_ACTIONS,
  type IamStatement,
} from "@/lib/iam-request-validation";
import { annotateIamRequest } from "@/lib/iam-resource-annotator";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const APPROVAL_TABLE = process.env.APPROVAL_TABLE ?? "cc-on-bedrock-approval-requests";

const dynamodb = new DynamoDBClient({ region });

const VALID_REQUEST_TYPES = ["tier_change", "dlp_change", "iam_extension"] as const;
type RequestType = (typeof VALID_REQUEST_TYPES)[number];

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const result = await dynamodb.send(
      new ScanCommand({
        TableName: APPROVAL_TABLE,
        FilterExpression: "email = :email",
        ExpressionAttributeValues: {
          ":email": { S: session.user.email },
        },
      })
    );

    const items = (result.Items ?? []).map((item) => unmarshall(item));
    items.sort((a, b) => (b.requestedAt ?? "").localeCompare(a.requestedAt ?? ""));

    return NextResponse.json({
      success: true,
      data: { requests: items, latest: items[0] ?? null },
    });
  } catch (err) {
    console.error("[user/container-request] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { type } = body as { type?: string };

    if (!type || !VALID_REQUEST_TYPES.includes(type as RequestType)) {
      return NextResponse.json(
        { error: `Invalid request type. Must be one of: ${VALID_REQUEST_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();
    const user = session.user;
    const subdomain = user.subdomain ?? "";

    const baseItem: Record<string, { S: string } | { N: string } | { L: { S: string }[] }> = {
      PK: { S: `REQUEST#${requestId}` },
      SK: { S: "META" },
      requestId: { S: requestId },
      type: { S: type },
      email: { S: user.email },
      // ADR-026 T2: persist the Cognito sub so approval can target the Local
      // Governance role (cc-on-bedrock-local-user-{sub}) without a Cognito lookup.
      sub: { S: user.id },
      subdomain: { S: subdomain },
      department: { S: (user as unknown as Record<string, string>).department ?? "default" },
      status: { S: "pending" },
      requestedAt: { S: now },
    };

    // Validate type-specific fields
    if (type === "tier_change") {
      const { newTier, reason } = body as { newTier?: string; reason?: string };
      if (!newTier || !["light", "standard", "power"].includes(newTier)) {
        return NextResponse.json({ error: "Invalid newTier (light/standard/power)" }, { status: 400 });
      }
      baseItem.newTier = { S: newTier };
      baseItem.currentTier = { S: user.resourceTier ?? "standard" };
      if (reason) baseItem.reason = { S: reason };
    } else if (type === "dlp_change") {
      const { newPolicy, reason } = body as { newPolicy?: string; reason?: string };
      if (!newPolicy || !["open", "restricted", "locked"].includes(newPolicy)) {
        return NextResponse.json({ error: "Invalid newPolicy (open/restricted/locked)" }, { status: 400 });
      }
      baseItem.newPolicy = { S: newPolicy };
      baseItem.currentPolicy = { S: user.securityPolicy ?? "restricted" };
      if (reason) baseItem.reason = { S: reason };
    } else if (type === "iam_extension") {
      const { statements, policySets, reason } = body as {
        statements?: IamStatement[];
        policySets?: string[];
        reason?: string;
      };
      // ADR-026: prefer free-form resource-specific `statements` (validated:
      // Resource:* banned, dangerous actions denied). Legacy `policySets` kept
      // for backward-compat until the request UI (T8) is migrated.
      if (statements && Array.isArray(statements) && statements.length > 0) {
        // Fail closed: without the platform account id we cannot enforce the
        // cross-account ARN guard, so a missing AWS_ACCOUNT_ID is a config error,
        // not a silent weakening of validation. (gate round-1: Gemini MAJOR)
        const accountId = process.env.AWS_ACCOUNT_ID;
        if (!accountId) {
          return NextResponse.json(
            { error: "Server misconfigured: AWS_ACCOUNT_ID is required to validate IAM requests" },
            { status: 500 }
          );
        }
        const built = buildIamExtensionRequest(
          { statements, reason },
          {
            serviceAllowlist: DEFAULT_SERVICE_ALLOWLIST,
            wildcardOkActions: DEFAULT_WILDCARD_OK_ACTIONS,
            accountId,
            region: process.env.AWS_REGION ?? region,
          },
        );
        if (!built.ok) {
          return NextResponse.json({ error: "Invalid IAM request", details: built.errors }, { status: 400 });
        }
        baseItem.statements = { S: built.statementsJson! };
        // ADR-026 T3/T8: advisory LLM risk note for the admin reviewer (graceful: null on failure).
        const llmNote = await annotateIamRequest(statements);
        if (llmNote) baseItem.llmNote = { S: llmNote };
      } else if (policySets && Array.isArray(policySets) && policySets.length > 0) {
        const invalid = policySets.filter((p) => !IAM_POLICY_SETS[p]);
        if (invalid.length > 0) {
          return NextResponse.json(
            { error: `Unknown policy sets: ${invalid.join(", ")}. Available: ${Object.keys(IAM_POLICY_SETS).join(", ")}` },
            { status: 400 }
          );
        }
        baseItem.policySets = { L: policySets.map((p) => ({ S: p })) };
      } else {
        return NextResponse.json({ error: "statements[] (or legacy policySets[]) is required" }, { status: 400 });
      }
      if (reason) baseItem.reason = { S: reason };
    }

    await dynamodb.send(new PutItemCommand({
      TableName: APPROVAL_TABLE,
      Item: baseItem,
    }));

    return NextResponse.json({
      success: true,
      data: { requestId, type },
    });
  } catch (err) {
    console.error("[user/container-request] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
