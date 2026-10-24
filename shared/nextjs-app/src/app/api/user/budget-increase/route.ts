import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DynamoDBClient, GetItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "crypto";
import { getCognitoUser } from "@/lib/aws-clients";
import { getRoleGroups } from "@/lib/role-admin";
import { hasRealDepartment, roleFromGroups } from "@/lib/roles";
import { periodKey } from "@/lib/budget-grants";
import {
  APPROVAL_TABLE,
  DEPT_BUDGETS_TABLE,
  USER_BUDGETS_TABLE,
  buildCreateTransaction,
  classifyCancellation,
  periodIsCapped,
  periodSnapshot,
  runTransaction,
  validateIncreaseInput,
} from "@/lib/budget-increase";

// One-time budget increase requests. Works in both deployment modes (no devenv gate):
// the USD budget is enforced by budget-check for EC2 DevEnv and Local Governance alike.
export const dynamic = "force-dynamic";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const dynamodb = new DynamoDBClient({ region });

/** The caller's own budget_increase requests, newest first. */
export async function GET() {
  const session = await getServerSession(authOptions);
  const email = (session?.user?.email ?? "").trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, never> | undefined;
    do {
      const res = await dynamodb.send(
        new ScanCommand({
          TableName: APPROVAL_TABLE,
          FilterExpression: "begins_with(PK, :req) AND email = :email AND #t = :type",
          ExpressionAttributeNames: { "#t": "type" },
          ExpressionAttributeValues: {
            ":req": { S: "REQUEST#" },
            ":email": { S: email },
            ":type": { S: "budget_increase" },
          },
          ExclusiveStartKey: startKey,
        })
      );
      items.push(...(res.Items ?? []).map((i) => unmarshall(i)));
      startKey = res.LastEvaluatedKey as Record<string, never> | undefined;
    } while (startKey);

    items.sort((a, b) => String(b.requestedAt ?? "").localeCompare(String(a.requestedAt ?? "")));
    const requests = items.map((u) => ({
      requestId: u.requestId,
      period: u.period,
      periodKey: u.periodKey,
      requestedAmount: Number(u.requestedAmount ?? 0),
      approvedAmount: u.approvedAmount !== undefined ? Number(u.approvedAmount) : undefined,
      reason: u.reason,
      status: u.status ?? "pending",
      requestedAt: u.requestedAt,
      approvedAt: u.approvedAt,
      approvedBy: u.approvedBy,
      rejectedAt: u.rejectedAt,
      rejectedBy: u.rejectedBy,
      rejectReason: u.rejectReason,
      snapshotSpend: Number(u.snapshotSpend ?? 0),
      snapshotBudget: Number(u.snapshotBudget ?? 0),
    }));
    return NextResponse.json({ success: true, data: { requests } });
  } catch (err) {
    console.error("[user/budget-increase] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/** Create a pending request: body `{ period, requestedAmount, reason }`. */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const sessionEmail = session?.user?.email ?? "";
  const email = sessionEmail.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = validateIncreaseInput(body ?? {});
  if (!input.ok) {
    return NextResponse.json({ error: input.error }, { status: 400 });
  }

  // Identity, department and role come from Cognito, never from the client or the
  // (up to 8h stale) session.
  let department: string;
  let subdomain: string;
  let requesterRole: string;
  try {
    const [user, groups] = await Promise.all([getCognitoUser(sessionEmail), getRoleGroups(sessionEmail)]);
    // No real department (blank / "default" placeholder) is stored as "": only an
    // admin can approve such a request and no department grant is written.
    const d = user.department ?? "";
    department = hasRealDepartment(d) ? d : "";
    subdomain = user.subdomain ?? "";
    requesterRole = roleFromGroups(groups).role;
  } catch (err) {
    console.error("[user/budget-increase] Cognito lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Identity check unavailable" }, { status: 503 });
  }

  try {
    const [userRes, deptRes] = await Promise.all([
      dynamodb.send(new GetItemCommand({ TableName: USER_BUDGETS_TABLE, Key: { user_id: { S: email } } })),
      department
        ? dynamodb.send(new GetItemCommand({ TableName: DEPT_BUDGETS_TABLE, Key: { dept_id: { S: department } } }))
        : Promise.resolve(undefined),
    ]);
    const userRow = userRes.Item ? unmarshall(userRes.Item) : undefined;
    const deptRow = deptRes?.Item ? unmarshall(deptRes.Item) : undefined;

    // 0 = unlimited: nothing to raise for this period.
    if (!periodIsCapped(input.period, userRow, deptRow)) {
      return NextResponse.json({ error: "unlimited_period" }, { status: 400 });
    }

    const now = new Date();
    const snapshot = periodSnapshot(input.period, userRow, deptRow);
    const requestId = randomUUID();
    const key = periodKey(input.period, now);
    const tx = buildCreateTransaction({
      requestId,
      email,
      department,
      period: input.period,
      periodKey: key,
      subdomain,
      requesterRole,
      requestedAmount: input.requestedAmount,
      reason: input.reason,
      snapshotSpend: snapshot.spend,
      snapshotBudget: snapshot.budget,
      requestedAt: now.toISOString(),
    });
    try {
      await runTransaction(tx);
    } catch (err) {
      const c = classifyCancellation(err, tx);
      if (c === null) throw err;
      if (c === "retry") return NextResponse.json({ error: "retry" }, { status: 503 });
      return NextResponse.json({ error: "pending_exists" }, { status: 409 });
    }

    return NextResponse.json({
      success: true,
      data: { requestId, status: "pending", period: input.period, periodKey: key },
    });
  } catch (err) {
    console.error("[user/budget-increase] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
