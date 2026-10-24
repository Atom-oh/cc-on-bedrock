import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DynamoDBClient, GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getCognitoUser } from "@/lib/aws-clients";
import { getRoleGroups, requireFreshRole } from "@/lib/role-admin";
import { hasRealDepartment, roleFromGroups, type Role } from "@/lib/roles";
import { DEPT_BUDGETS_TABLE, USER_BUDGETS_TABLE } from "@/lib/budget-increase";
import { canSetMemberLimit, validateMemberLimits, MEMBER_LIMIT_FIELDS } from "@/lib/dept-limit-authz";
import { syncMonthlyLimitMirror } from "@/lib/limit-mirror";
import { applyLimitChange, pickNumbers } from "@/lib/limit-audit";

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
  if (fresh.role !== "admin") {
    try {
      actorDepartment = (await getCognitoUser(actorEmail)).department ?? "";
    } catch (err) {
      if (isUserNotFound(err)) {
        return NextResponse.json({ error: "no_department" }, { status: 403 });
      }
      console.error("[dept/user-budgets] actor lookup failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "Role check unavailable" }, { status: 503 });
    }
    if (!hasRealDepartment(actorDepartment)) {
      return NextResponse.json({ error: "no_department" }, { status: 403 });
    }
  }
  let targetDepartment: string;
  try {
    targetDepartment = (await getCognitoUser(targetEmail)).department ?? "";
  } catch (err) {
    if (isUserNotFound(err)) {
      return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    }
    console.error("[dept/user-budgets] target lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Role check unavailable" }, { status: 503 });
  }
  // A manager may only manage plain users: the target's FRESH role decides (fail closed).
  let targetRole: Role | undefined;
  if (fresh.role !== "admin") {
    try {
      targetRole = roleFromGroups(await getRoleGroups(targetEmail)).role;
    } catch (err) {
      console.error("[dept/user-budgets] target role lookup failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "Role check unavailable" }, { status: 503 });
    }
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
      target: { email: targetEmail, department: targetDepartment, role: targetRole },
      monthlyBudget: limits.monthlyBudget,
      deptMonthlyBudget,
    });
    if (!decision.ok) {
      const status = decision.error === "exceeds_department_total" ? 400 : 403;
      return NextResponse.json(
        decision.error === "exceeds_department_total"
          ? { error: decision.error, deptMonthlyBudget }
          : { error: decision.error },
        { status }
      );
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
    const Key = { user_id: { S: targetEmail } };
    const current = await dynamodb.send(new GetItemCommand({ TableName: USER_BUDGETS_TABLE, Key }));
    // Row update + limit_change audit commit together (lib/limit-audit).
    await applyLimitChange(
      {
        TableName: USER_BUDGETS_TABLE,
        Key,
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
      },
      {
        actor: actorEmail,
        actorRole: fresh.role,
        targetType: "user",
        email: targetEmail,
        department: targetDepartment,
        before: pickNumbers(current.Item ? unmarshall(current.Item) : undefined, changed),
        after: pickNumbers(limits, changed),
        appliedAt: now,
      }
    );
    if (limits.monthlyBudget !== undefined) {
      await syncMonthlyLimitMirror(targetEmail, limits.monthlyBudget, now);
    }

    return NextResponse.json({ success: true, data: { email: targetEmail, ...limits } });
  } catch (err) {
    console.error("[dept/user-budgets] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
