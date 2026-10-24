import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getCognitoUser, listCognitoUsers } from "@/lib/aws-clients";
import { requireFreshRole } from "@/lib/role-admin";
import { hasRealDepartment } from "@/lib/roles";
import { getUsageRecords } from "@/lib/usage-client";
import type { DeptBudget, MemberBudgetStatus, PendingRequest } from "@/lib/types";
import { budgetStatus, readTokenDeniedUsers, readUserBudgetRows } from "@/lib/budget-status";
import { grantAttr, periodKey } from "@/lib/budget-grants";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
const APPROVAL_REQUESTS_TABLE = process.env.APPROVAL_REQUESTS_TABLE ?? "cc-on-bedrock-approval-requests";

const dynamodb = new DynamoDBClient({ region });

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  // Fresh role (session groups can be up to 8h stale).
  const fresh = await requireFreshRole(session, ["admin", "dept-manager"]);
  if (!fresh.ok) return fresh.response;
  const isAdmin = fresh.role === "admin";

  // A dept-manager's department is read fresh from Cognito (never the session or
  // the email domain). Admin can filter by department via query parameter.
  let department: string;
  if (isAdmin) {
    department = req.nextUrl.searchParams.get("department") ?? "all";
  } else {
    try {
      department = (await getCognitoUser(session.user.email)).department ?? "";
    } catch (err) {
      if ((err as { name?: string })?.name !== "UserNotFoundException") {
        console.error("[dept] department lookup failed:", err instanceof Error ? err.message : err);
        return NextResponse.json({ error: "Role check unavailable" }, { status: 503 });
      }
      department = ""; // deleted actor: no department → empty results below
    }
    // fail-closed: a manager without a real department sees nothing.
    if (!hasRealDepartment(department)) {
      return NextResponse.json({
        success: true,
        data: { department: "", members: [], budget: null, pendingRequests: [], monthlyUsage: [] },
      });
    }
  }

  try {
    // Fetch department members from Cognito
    const allUsers = await listCognitoUsers();
    const members = department === "all"
      ? allUsers
      : allUsers.filter((u) => u.department === department);

    // Fetch department budget from DynamoDB
    let budget: DeptBudget | null = null;
    let deptRow: Record<string, unknown> | undefined;
    try {
      if (department === "all") {
        // For "all" view, aggregate budget across all departments
        budget = {
          department: "all",
          monthlyBudget: 0,
          currentSpend: 0,
          monthlyTokenLimit: 0,
          currentTokens: 0,
        };
      } else {
        // cc-department-budgets is keyed by `dept_id` (partition key) with a plain
        // department id — NOT a `PK`/`DEPT#…` composite. A single-item lookup, so
        // GetItem (matches admin/budgets writer + budget-check.py enforcement).
        const budgetResult = await dynamodb.send(
          new GetItemCommand({
            TableName: DEPT_BUDGETS_TABLE,
            Key: { dept_id: { S: department } },
          })
        );

        if (budgetResult.Item) {
          const item = unmarshall(budgetResult.Item);
          deptRow = item;
          budget = {
            department: item.department ?? department,
            // 0 = unlimited (matches budget-check.py: cap <= 0 → no deny). Don't
            // invent a fake 1000 cap for depts that are intentionally uncapped.
            monthlyBudget: item.monthlyBudget ?? 0,
            currentSpend: item.currentSpend ?? 0,
            monthlyTokenLimit: item.monthlyTokenLimit ?? 0,
            currentTokens: item.currentTokens ?? 0,
            // Inputs of the approval route's department-cap check (pre-check in the UI).
            recordedSpend: Number(item.currentSpend ?? 0) || 0,
            monthGranted: Number(item[grantAttr("monthly", periodKey("monthly", new Date()))] ?? 0) || 0,
          };
        } else {
          // No budget row → unlimited (0), consistent with enforcement.
          budget = {
            department,
            monthlyBudget: 0,
            currentSpend: 0,
            monthlyTokenLimit: 0,
            currentTokens: 0,
          };
        }
      }
    } catch (err) {
      console.warn("[dept] Budget fetch error:", err);
      // On fetch error, show unlimited (0) rather than a fabricated cap.
      budget = {
        department,
        monthlyBudget: 0,
        currentSpend: 0,
        monthlyTokenLimit: 0,
        currentTokens: 0,
      };
    }

    // Fetch pending approval requests from DynamoDB
    let pendingRequests: PendingRequest[] = [];
    try {
      const requestsResult = await dynamodb.send(
        new ScanCommand({
          TableName: APPROVAL_REQUESTS_TABLE,
          FilterExpression: "#status = :pending" + (department === "all" ? "" : " AND department = :dept"),
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":pending": { S: "pending" },
            ...(department === "all" ? {} : { ":dept": { S: department } }),
          },
        })
      );

      pendingRequests = (requestsResult.Items ?? []).map((item) => {
        const u = unmarshall(item);
        return {
          requestId: u.requestId ?? u.PK?.replace("REQUEST#", "") ?? "",
          type: u.type ?? "container_request", // legacy requests don't have type
          period: u.period,
          periodKey: u.periodKey,
          requestedAmount: u.requestedAmount !== undefined ? Number(u.requestedAmount) : undefined,
          email: u.email ?? "",
          subdomain: u.subdomain ?? "",
          containerOs: u.containerOs ?? "ubuntu",
          resourceTier: u.resourceTier ?? "standard",
          requestedAt: u.requestedAt ?? u.createdAt ?? "",
          status: u.status ?? "pending",
          department: u.department ?? "default",
        };
      });
    } catch (err) {
      console.warn("[dept] Approval requests fetch error:", err);
      // Continue with empty pending requests
    }

    // Calculate monthly usage from usage records
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    const today = now.toISOString().split("T")[0];

    let monthlyUsage: { date: string; cost: number; tokens: number }[] = [];
    try {
      const usageRecords = await getUsageRecords({
        startDate: firstDayOfMonth,
        endDate: today,
        department: department === "all" ? undefined : department,
      });

      // Aggregate by date
      const dateMap = new Map<string, { cost: number; tokens: number }>();
      for (const r of usageRecords) {
        const existing = dateMap.get(r.date) ?? { cost: 0, tokens: 0 };
        existing.cost += r.estimatedCost;
        existing.tokens += r.totalTokens;
        dateMap.set(r.date, existing);
      }

      monthlyUsage = Array.from(dateMap.entries())
        .map(([date, { cost, tokens }]) => ({ date, cost, tokens }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Update budget with actual usage
      if (budget) {
        const totalCost = usageRecords.reduce((sum, r) => sum + r.estimatedCost, 0);
        const totalTokens = usageRecords.reduce((sum, r) => sum + r.totalTokens, 0);
        budget.currentSpend = totalCost;
        budget.currentTokens = totalTokens;
      }
    } catch (err) {
      console.warn("[dept] Monthly usage fetch error:", err);
    }

    // One department: each member's standing limits, caps with current grants and
    // block cause (blocked list). Best-effort: the members list still renders without it.
    const budgetRows = new Map<string, Record<string, unknown>>();
    let tokenDenied = new Set<string>();
    let statusAvailable = false;
    if (department !== "all" && members.length > 0) {
      try {
        const [rows, denied] = await Promise.all([
          readUserBudgetRows(members.map((m) => m.email)),
          readTokenDeniedUsers(),
        ]);
        rows.forEach((v, k) => budgetRows.set(k, v));
        tokenDenied = denied;
        statusAvailable = true;
      } catch (err) {
        console.warn("[dept] Member budget status fetch error:", err instanceof Error ? err.message : err);
      }
    }

    // Format members for response
    const formattedMembers = members.map((m) => {
      const key = (m.email ?? "").trim().toLowerCase();
      const row = budgetRows.get(key);
      const status: MemberBudgetStatus | undefined = statusAvailable
        ? budgetStatus(row, deptRow, now, tokenDenied.has(key))
        : undefined;
      return {
        username: m.username,
        email: m.email,
        subdomain: m.subdomain,
        containerOs: m.containerOs,
        resourceTier: m.resourceTier,
        status: m.status,
        ...(statusAvailable
          ? {
              limits: {
                dailyBudget: Number(row?.dailyBudget ?? 0) || 0,
                weeklyBudget: Number(row?.weeklyBudget ?? 0) || 0,
                monthlyBudget: Number(row?.monthlyBudget ?? 0) || 0,
              },
              budgetStatus: status,
            }
          : {}),
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        department,
        members: formattedMembers,
        budget,
        pendingRequests,
        monthlyUsage,
      },
    });
  } catch (err) {
    console.error("[dept] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
