import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { updateCognitoUserAttribute } from "@/lib/aws-clients";
import { emailToSubdomain } from "@/lib/utils";
import {
  changeTier,
  changeSecurityPolicy,
  addIamPolicySet,
  IAM_POLICY_SETS,
} from "@/lib/ec2-clients";
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const APPROVAL_TABLE = process.env.APPROVAL_TABLE ?? "cc-on-bedrock-approval-requests";

const dynamodb = new DynamoDBClient({ region });

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status"); // optional: pending, approved, rejected

  try {
    const scanParams: Record<string, unknown> = { TableName: APPROVAL_TABLE };
    if (statusFilter) {
      scanParams.FilterExpression = "#s = :status";
      scanParams.ExpressionAttributeNames = { "#s": "status" };
      scanParams.ExpressionAttributeValues = { ":status": { S: statusFilter } };
    }

    const result = await dynamodb.send(new ScanCommand(scanParams as never));

    const requests = (result.Items ?? []).map((item) => {
      const u = unmarshall(item);
      return {
        requestId: u.requestId ?? "",
        type: u.type ?? "container_request", // legacy requests don't have type
        email: u.email ?? "",
        subdomain: u.subdomain ?? "",
        department: u.department ?? "default",
        status: u.status ?? "pending",
        requestedAt: u.requestedAt ?? "",
        approvedAt: u.approvedAt,
        approvedBy: u.approvedBy,
        rejectedAt: u.rejectedAt,
        rejectedBy: u.rejectedBy,
        // Type-specific fields
        newTier: u.newTier,
        currentTier: u.currentTier,
        newPolicy: u.newPolicy,
        currentPolicy: u.currentPolicy,
        policySets: u.policySets,
        reason: u.reason,
        // Legacy fields
        resourceTier: u.resourceTier,
        containerOs: u.containerOs,
      };
    });

    requests.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

    return NextResponse.json({
      success: true,
      data: requests,
      meta: { policySetCatalog: Object.entries(IAM_POLICY_SETS).map(([id, ps]) => ({ id, ...ps })) },
    });
  } catch (err) {
    console.error("[admin/approval-requests] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { requestId, action } = body as {
      requestId: string;
      action: "approve" | "reject";
    };

    if (!requestId) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    if (!["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
    }

    const pk = `REQUEST#${requestId}`;
    const now = new Date().toISOString();

    if (action === "reject") {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: APPROVAL_TABLE,
          Key: { PK: { S: pk }, SK: { S: "META" } },
          UpdateExpression: "SET #s = :status, rejectedBy = :admin, rejectedAt = :now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":status": { S: "rejected" },
            ":admin": { S: session.user.email },
            ":now": { S: now },
          },
        })
      );
      return NextResponse.json({ success: true, data: { requestId, status: "rejected" } });
    }

    // Approve: fetch the request, apply changes, then mark approved
    const getResult = await dynamodb.send(new GetItemCommand({
      TableName: APPROVAL_TABLE,
      Key: { PK: { S: pk }, SK: { S: "META" } },
    }));

    if (!getResult.Item) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }

    const request = unmarshall(getResult.Item);
    const requestType = request.type as string;
    const subdomain = request.subdomain as string;
    const email = request.email as string;

    let applyResult: Record<string, unknown> = {};

    // Auto-apply based on request type
    if (requestType === "tier_change") {
      const newTier = request.newTier as "light" | "standard" | "power";
      const result = await changeTier(subdomain, newTier);
      await updateCognitoUserAttribute(email, "custom:resource_tier", newTier);
      applyResult = { tierChange: result };
    } else if (requestType === "dlp_change") {
      const newPolicy = request.newPolicy as "open" | "restricted" | "locked";
      const result = await changeSecurityPolicy(subdomain, newPolicy);
      await updateCognitoUserAttribute(email, "custom:security_policy", newPolicy);
      applyResult = { dlpChange: result };
    } else if (requestType === "iam_extension") {
      const policySets = request.policySets as string[];
      const results = [];
      for (const ps of policySets) {
        const result = await addIamPolicySet(subdomain, ps);
        results.push(result);
      }
      applyResult = { iamPolicies: results };
    } else {
      // Legacy container_request: just approve and assign subdomain
      const assignedSubdomain = subdomain || emailToSubdomain(email);
      await updateCognitoUserAttribute(email, "custom:subdomain", assignedSubdomain);
      await updateCognitoUserAttribute(email, "custom:resource_tier", request.resourceTier ?? "standard");
      applyResult = { subdomain: assignedSubdomain };
    }

    // Mark as approved + applied
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: APPROVAL_TABLE,
        Key: { PK: { S: pk }, SK: { S: "META" } },
        UpdateExpression: "SET #s = :status, approvedBy = :admin, approvedAt = :now, appliedResult = :result",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": { S: "approved" },
          ":admin": { S: session.user.email },
          ":now": { S: now },
          ":result": { S: JSON.stringify(applyResult) },
        },
      })
    );

    return NextResponse.json({
      success: true,
      data: { requestId, status: "approved", applied: applyResult },
    });
  } catch (err) {
    console.error("[admin/approval-requests] POST", err instanceof Error ? err.message : err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
