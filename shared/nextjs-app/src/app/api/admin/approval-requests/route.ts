import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCognitoUser, updateCognitoUserAttribute } from "@/lib/aws-clients";
import { emailToSubdomain } from "@/lib/utils";
import {
  changeTier,
  changeSecurityPolicy,
  addIamPolicySet,
  applyIamGrant,
  IAM_POLICY_SETS,
} from "@/lib/ec2-clients";
import type { IamStatement } from "@/lib/iam-request-validation";
import {
  canApproveBudgetIncrease,
  canApproveRequest,
  type ApproverUser,
} from "@/lib/approval-authz";
import { getRoleGroups, requireFreshRole } from "@/lib/role-admin";
import { hasRealDepartment, roleFromGroups } from "@/lib/roles";
import { BUDGET_PERIODS } from "@/lib/budget-periods";
import { grantAttr, periodKey } from "@/lib/budget-grants";
import {
  DEPT_BUDGETS_TABLE,
  RELEASE_ETA_MINUTES,
  USER_BUDGETS_TABLE,
  approvedGrants,
  buildApproveTransaction,
  buildExpireTransaction,
  buildRejectTransaction,
  isBudgetPeriod,
  isTransactionCanceled,
  isValidIncreaseAmount,
  periodIsCapped,
  removeStaleGrants,
  runTransaction,
  staleGrantAttrs,
  type BudgetIncreaseRecord,
} from "@/lib/budget-increase";
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { Session } from "next-auth";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const APPROVAL_TABLE = process.env.APPROVAL_TABLE ?? "cc-on-bedrock-approval-requests";

const dynamodb = new DynamoDBClient({ region });

// ADR-026 T7 — approval authz lives in @/lib/approval-authz (pure, unit-tested).

/**
 * The approver built from FRESH Cognito data: the session's groups and department
 * can be up to 8h stale. A dept-manager without a real department (blank or the
 * "default" placeholder) gets no department, so department checks fail closed.
 */
async function freshApprover(
  session: Session | null
): Promise<{ ok: true; approver: ApproverUser } | { ok: false; response: NextResponse }> {
  const email = session?.user?.email;
  if (!email) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Approver access required (admin or dept-manager)" }, { status: 403 }),
    };
  }
  const fresh = await requireFreshRole(session, ["admin", "dept-manager"]);
  if (!fresh.ok) return fresh;
  let department: string | undefined;
  if (fresh.role !== "admin") {
    try {
      const d = (await getCognitoUser(email)).department ?? "";
      department = hasRealDepartment(d) ? d : undefined;
    } catch (err) {
      console.error("[admin/approval-requests] approver lookup failed:", err instanceof Error ? err.message : err);
      return { ok: false, response: NextResponse.json({ error: "Role check unavailable" }, { status: 503 }) };
    }
  }
  return {
    ok: true,
    approver: { email, isAdmin: fresh.role === "admin", groups: [fresh.role], department },
  };
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const auth = await freshApprover(session);
  if (!auth.ok) return auth.response;
  const approver = auth.approver;

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status"); // optional: pending, approved, rejected

  try {
    // Requests only: budget_increase lock items (PENDING#...) share the table.
    const scanParams: Record<string, unknown> = {
      TableName: APPROVAL_TABLE,
      FilterExpression: "begins_with(PK, :req)",
      ExpressionAttributeValues: { ":req": { S: "REQUEST#" } },
    };
    if (statusFilter) {
      scanParams.FilterExpression = "begins_with(PK, :req) AND #s = :status";
      scanParams.ExpressionAttributeNames = { "#s": "status" };
      scanParams.ExpressionAttributeValues = { ":req": { S: "REQUEST#" }, ":status": { S: statusFilter } };
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
        statements: u.statements, // ADR-026: JSON string of requested action+resource
        llmNote: u.llmNote, // ADR-026 T3: advisory LLM risk summary
        reason: u.reason,
        // budget_increase
        requesterRole: u.requesterRole,
        period: u.period,
        periodKey: u.periodKey,
        requestedAmount: u.requestedAmount !== undefined ? Number(u.requestedAmount) : undefined,
        approvedAmount: u.approvedAmount !== undefined ? Number(u.approvedAmount) : undefined,
        snapshotSpend: u.snapshotSpend !== undefined ? Number(u.snapshotSpend) : undefined,
        snapshotBudget: u.snapshotBudget !== undefined ? Number(u.snapshotBudget) : undefined,
        rejectReason: u.rejectReason,
        expiredAt: u.expiredAt,
        // Legacy fields
        resourceTier: u.resourceTier,
        containerOs: u.containerOs,
      };
    });

    requests.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

    // dept-manager (non-admin) sees only their own department's requests.
    // fail-closed: a dept-manager with no department sees nothing (gate round-1 Codex MAJOR).
    const visible = approver.isAdmin
      ? requests
      : approver.department
        ? requests.filter((r) => r.department === approver.department)
        : [];

    return NextResponse.json({
      success: true,
      data: visible,
      meta: { policySetCatalog: Object.entries(IAM_POLICY_SETS).map(([id, ps]) => ({ id, ...ps })) },
    });
  } catch (err) {
    console.error("[admin/approval-requests] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const auth = await freshApprover(session);
  if (!auth.ok) return auth.response;
  const approver = auth.approver;

  try {
    const body = await req.json();
    const { requestId, action } = body as {
      requestId: string;
      action: "approve" | "reject";
      amount?: unknown; // budget_increase: approver-adjusted amount
      reason?: unknown; // budget_increase: rejection reason
    };

    if (!requestId) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    if (!["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
    }

    const pk = `REQUEST#${requestId}`;
    const now = new Date().toISOString();

    // Fetch the request FIRST and authorize on its STORED department (never a
    // client-supplied value) — a dept-manager may only act on their own dept.
    const getResult = await dynamodb.send(new GetItemCommand({
      TableName: APPROVAL_TABLE,
      Key: { PK: { S: pk }, SK: { S: "META" } },
    }));
    if (!getResult.Item) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }
    const request = unmarshall(getResult.Item);
    if (request.type === "budget_increase") {
      return await decideBudgetIncrease(request, approver, action, body);
    }
    // Pass the STORED department verbatim (empty string when missing) — do NOT
    // coerce to "default", else a default-dept manager could approve dept-less
    // requests. Missing department → dept-manager denied; admin still allowed.
    if (!canApproveRequest(approver, (request.department as string) ?? "", (request.email as string) ?? "")) {
      return NextResponse.json({ error: "Not authorized for this request's department" }, { status: 403 });
    }

    // Idempotency (review suggestion): a request already approved/rejected is not
    // re-processed — avoids re-attaching grants or flipping a decided request.
    const currentStatus = (request.status as string) ?? "pending";
    if (currentStatus !== "pending") {
      return NextResponse.json(
        { success: true, data: { requestId, status: currentStatus, alreadyProcessed: true } },
      );
    }

    if (action === "reject") {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: APPROVAL_TABLE,
          Key: { PK: { S: pk }, SK: { S: "META" } },
          UpdateExpression: "SET #s = :status, rejectedBy = :admin, rejectedAt = :now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":status": { S: "rejected" },
            ":admin": { S: approver.email },
            ":now": { S: now },
          },
        })
      );
      return NextResponse.json({ success: true, data: { requestId, status: "rejected" } });
    }

    // Approve: apply changes (request already fetched + authorized above)
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
      // ADR-026 T5: free-form statements grant onto BOTH task + local roles
      // (re-validated server-side). Legacy policySets kept for back-compat.
      if (request.statements) {
        const statements = JSON.parse(request.statements as string) as IamStatement[];
        const grant = await applyIamGrant({
          subdomain,
          sub: (request.sub as string) ?? "",
          requestId: request.requestId as string,
          statements,
        });
        applyResult = { iamGrant: grant };
      } else {
        const policySets = (request.policySets as string[]) ?? [];
        const results = [];
        for (const ps of policySets) {
          const result = await addIamPolicySet(subdomain, ps);
          results.push(result);
        }
        applyResult = { iamPolicies: results };
      }
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
          ":admin": { S: approver.email },
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

/**
 * budget_increase approve/reject. Every write is one conditional transaction on
 * `status = pending`, so a concurrent decision loses with 409 already_decided.
 */
async function decideBudgetIncrease(
  request: Record<string, unknown>,
  approver: ApproverUser,
  action: "approve" | "reject",
  body: { amount?: unknown; reason?: unknown }
): Promise<NextResponse> {
  const requestId = String(request.requestId ?? "");
  const email = String(request.email ?? "").trim().toLowerCase();
  const department = String(request.department ?? "");

  // Self ban + department scope first, so the status of another department's
  // request is not disclosed.
  if (!canApproveRequest(approver, department, email)) {
    const self = !email || email === approver.email.trim().toLowerCase();
    return NextResponse.json({ error: self ? "self" : "other_department" }, { status: 403 });
  }

  const currentStatus = (request.status as string) ?? "pending";
  if (currentStatus !== "pending") {
    return NextResponse.json({ success: true, data: { requestId, status: currentStatus, alreadyProcessed: true } });
  }

  if (!isBudgetPeriod(request.period) || typeof request.periodKey !== "string") {
    return NextResponse.json({ error: "Malformed budget_increase request" }, { status: 400 });
  }
  const record: BudgetIncreaseRecord = {
    requestId,
    email,
    department,
    period: request.period,
    periodKey: request.periodKey,
  };
  const now = new Date();

  if (action === "reject") {
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    try {
      await runTransaction(buildRejectTransaction(record, approver.email, reason, now));
    } catch (err) {
      if (isTransactionCanceled(err)) return NextResponse.json({ error: "already_decided" }, { status: 409 });
      throw err;
    }
    return NextResponse.json({ success: true, data: { requestId, status: "rejected" } });
  }

  const amount = body.amount === undefined ? Number(request.requestedAmount) : body.amount;
  if (!isValidIncreaseAmount(amount)) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  // Fresh reads: requester's current role, the department's cap state, the user's caps.
  let requesterIsDeptManager: boolean;
  try {
    const { role } = roleFromGroups(await getRoleGroups(email));
    requesterIsDeptManager = role !== "user"; // a manager (or admin) request needs an admin
  } catch (err) {
    console.error("[admin/approval-requests] requester role lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Role check unavailable" }, { status: 503 });
  }
  const [deptRes, userRes] = await Promise.all([
    department
      ? dynamodb.send(new GetItemCommand({ TableName: DEPT_BUDGETS_TABLE, Key: { dept_id: { S: department } } }))
      : Promise.resolve(undefined),
    dynamodb.send(new GetItemCommand({ TableName: USER_BUDGETS_TABLE, Key: { user_id: { S: email } } })),
  ]);
  const deptRow = deptRes?.Item ? unmarshall(deptRes.Item) : undefined;
  const userRow = userRes.Item ? unmarshall(userRes.Item) : undefined;

  const decision = canApproveBudgetIncrease(
    approver,
    { ...record, requesterIsDeptManager },
    amount,
    {
      monthlyBudget: Number(deptRow?.monthlyBudget ?? 0),
      monthSpend: Number(deptRow?.currentSpend ?? 0),
      monthGranted: Number(deptRow?.[grantAttr("monthly", periodKey("monthly", now))] ?? 0),
    },
    now
  );
  if (!decision.ok) {
    if (decision.reason === "invalid_amount") {
      return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
    }
    if (decision.reason === "expired") {
      try {
        await runTransaction(buildExpireTransaction(record, now));
      } catch (err) {
        if (!isTransactionCanceled(err)) throw err; // decided concurrently — nothing to expire
      }
      return NextResponse.json({ error: "expired" }, { status: 409 });
    }
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  // A period with no base cap stays unlimited; a grant there would be meaningless.
  const skipPeriods = BUDGET_PERIODS.filter((p) => !periodIsCapped(p, userRow, deptRow));
  try {
    await runTransaction(buildApproveTransaction(record, amount, approver.email, now, { skipPeriods }));
  } catch (err) {
    if (isTransactionCanceled(err)) return NextResponse.json({ error: "already_decided" }, { status: 409 });
    throw err;
  }
  if (userRow) await removeStaleGrants(email, staleGrantAttrs(userRow, now));

  return NextResponse.json({
    success: true,
    data: {
      requestId,
      status: "approved",
      applied: {
        grants: approvedGrants(record, amount, now, skipPeriods),
        releaseEtaMinutes: RELEASE_ETA_MINUTES,
      },
    },
  });
}
