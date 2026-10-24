import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getCognitoUser } from "@/lib/aws-clients";
import { requireFreshRole } from "@/lib/role-admin";
import { hasRealDepartment } from "@/lib/roles";
import { DEPT_BUDGETS_TABLE, USER_BUDGETS_TABLE } from "@/lib/budget-increase";
import { canSetMemberLimit, validateMemberLimits, MEMBER_LIMIT_FIELDS } from "@/lib/dept-limit-authz";
import { syncMonthlyLimitMirror } from "@/lib/limit-mirror";
import { pickNumbers, recordLimitChange } from "@/lib/limit-audit";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const dynamodb = new DynamoDBClient({ region });

function isUserNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "UserNotFoundException";
}

/**
 * Standing per-user limits (daily / weekly / monthly USD; 0 = inherit) set by an
 * admin or by a dept-manager for a member of their own department. Actor role and
 * department, and the target's department, are read fresh from Cognito.
 */
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const fresh = await requireFreshRole(session, ["admin", "dept-manager"]);
  if (!fresh.ok) return fresh.response;
  const actorEmail = session.user.email;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const targetEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!targetEmail) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  const valid = validateMemberLimits(body);
  if (!valid.ok) {
    return NextResponse.json({ error: valid.error }, { status: 400 });
  }
  const limits = valid.limits;

  // Fresh departments. A dept-manager without a real department can manage nobody.
  let actorDepartment: string | undefined;
  let targetDepartment: string;
  try {
    if (fresh.role !== "admin") {
      const d = (await getCognitoUser(actorEmail)).department ?? "";
      if (!hasRealDepartment(d)) {
        return NextResponse.json({ error: "no_department" }, { status: 403 });
      }
      actorDepartment = d;
    }
    targetDepartment = (await getCognitoUser(targetEmail)).department ?? "";
  } catch (err) {
    if (isUserNotFound(err)) {
      return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    }
    console.error("[dept/user-budgets] Cognito lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Role check unavailable" }, { status: 503 });
  }

  try {
    // Department total only constrains a manager's change (admins are not capped).
    let deptMonthlyBudget = 0;
    if (actorDepartment && limits.monthlyBudget !== undefined) {
      const dept = await dynamodb.send(new GetItemCommand({
        TableName: DEPT_BUDGETS_TABLE,
        Key: { dept_id: { S: actorDepartment } },
      }));
      deptMonthlyBudget = Number(dept.Item ? unmarshall(dept.Item).monthlyBudget ?? 0 : 0) || 0;
    }

    const decision = canSetMemberLimit({
      actor: { email: actorEmail, role: fresh.role, department: actorDepartment },
      target: { email: targetEmail, department: targetDepartment },
      monthlyBudget: limits.monthlyBudget,
      deptMonthlyBudget,
    });
    if (!decision.ok) {
      const status = decision.error === "exceeds_department_total" ? 400 : 403;
      return NextResponse.json({ error: decision.error, deptMonthlyBudget }, { status });
    }

    const now = new Date().toISOString();
    const changed = MEMBER_LIMIT_FIELDS.filter((f) => limits[f] !== undefined);
    const exprValues: Record<string, AttributeValue> = { ":now": { S: now } };
    const updateParts = ["updatedAt = :now"];
    for (const f of changed) {
      updateParts.push(`${f} = :${f}`);
      exprValues[`:${f}`] = { N: String(limits[f]) };
    }
    // ADR-031 (B′): cc-user-budgets and LIMIT#monthly are keyed by the lowercased email.
    const updated = await dynamodb.send(new UpdateItemCommand({
      TableName: USER_BUDGETS_TABLE,
      Key: { user_id: { S: targetEmail } },
      UpdateExpression: `SET ${updateParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ReturnValues: "UPDATED_OLD",
    }));
    if (limits.monthlyBudget !== undefined) {
      await syncMonthlyLimitMirror(targetEmail, limits.monthlyBudget, now);
    }

    // Audit after the change fully applied (row + mirror); a failed audit write does
    // not roll it back, so report it rather than a misleading 500.
    let auditRecorded = true;
    try {
      await recordLimitChange({
        actor: actorEmail,
        actorRole: fresh.role,
        targetType: "user",
        email: targetEmail,
        department: targetDepartment,
        before: pickNumbers(updated.Attributes ? unmarshall(updated.Attributes) : undefined, changed),
        after: pickNumbers(limits, changed),
        appliedAt: now,
      });
    } catch (err) {
      auditRecorded = false;
      console.error("[dept/user-budgets] limit_change audit failed:", err instanceof Error ? err.message : err);
    }

    return NextResponse.json({
      success: true,
      data: { email: targetEmail, ...limits },
      ...(auditRecorded ? {} : { warning: "audit_failed" }),
    });
  } catch (err) {
    console.error("[dept/user-budgets] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
