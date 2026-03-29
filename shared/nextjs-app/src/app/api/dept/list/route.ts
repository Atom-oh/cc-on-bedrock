import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listCognitoUsers } from "@/lib/aws-clients";
import { getDepartmentSummaries } from "@/lib/usage-client";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DepartmentListItem } from "@/lib/types";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
const APPROVAL_REQUESTS_TABLE = process.env.APPROVAL_REQUESTS_TABLE ?? "cc-on-bedrock-approval-requests";
const dynamodb = new DynamoDBClient({ region });

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const groups = session.user.groups ?? [];
  if (!groups.includes("admin")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    // Parallel fetch: Cognito users, usage summaries, budgets, pending requests
    const [allUsers, usageSummaries, budgetsResult, pendingResult] = await Promise.all([
      listCognitoUsers(),
      getDepartmentSummaries(),
      dynamodb.send(new ScanCommand({ TableName: DEPT_BUDGETS_TABLE })).catch(() => ({ Items: [] })),
      dynamodb.send(new ScanCommand({
        TableName: APPROVAL_REQUESTS_TABLE,
        FilterExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pending": { S: "pending" } },
      })).catch(() => ({ Items: [] })),
    ]);

    // Build budget map
    const budgetMap = new Map<string, number>();
    for (const item of budgetsResult.Items ?? []) {
      const u = unmarshall(item);
      const dept = u.department ?? u.PK?.replace("DEPT#", "") ?? "";
      if (dept) budgetMap.set(dept, u.monthlyBudget ?? 1000);
    }

    // Build pending count map
    const pendingMap = new Map<string, number>();
    for (const item of pendingResult.Items ?? []) {
      const u = unmarshall(item);
      const dept = u.department ?? "default";
      pendingMap.set(dept, (pendingMap.get(dept) ?? 0) + 1);
    }

    // Build member count map from Cognito
    const memberMap = new Map<string, number>();
    for (const u of allUsers) {
      const dept = u.department || "default";
      memberMap.set(dept, (memberMap.get(dept) ?? 0) + 1);
    }

    // Collect all unique departments
    const allDepts = new Set<string>();
    for (const u of allUsers) allDepts.add(u.department || "default");
    for (const s of usageSummaries) allDepts.add(s.department);

    // Build department list
    const departments: DepartmentListItem[] = Array.from(allDepts).map((dept) => {
      const usage = usageSummaries.find((s) => s.department === dept);
      const monthlyBudget = budgetMap.get(dept) ?? 1000;
      const totalCost = usage?.totalCost ?? 0;
      return {
        department: dept,
        memberCount: memberMap.get(dept) ?? 0,
        totalCost,
        totalTokens: usage?.totalTokens ?? 0,
        requests: usage?.requests ?? 0,
        budgetUtilization: monthlyBudget > 0 ? Math.round((totalCost / monthlyBudget) * 100) : 0,
        monthlyBudget,
        pendingCount: pendingMap.get(dept) ?? 0,
      };
    }).sort((a, b) => b.totalCost - a.totalCost);

    return NextResponse.json({ success: true, data: { departments } });
  } catch (err) {
    console.error("[dept/list] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
