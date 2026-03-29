import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
import { listCognitoUsers } from "@/lib/aws-clients";
import { getUsageRecords } from "@/lib/usage-client";
import type { DeptBudget, PendingRequest } from "@/lib/types";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
const APPROVAL_REQUESTS_TABLE = process.env.APPROVAL_REQUESTS_TABLE ?? "cc-on-bedrock-approval-requests";

const dynamodb = new DynamoDBClient({ region });

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  // Check if user is dept-manager or admin
  const groups = session.user.groups ?? [];
  const isDeptManager = groups.includes("dept-manager") || groups.includes("admin");
  const isAdmin = groups.includes("admin");

  if (!isDeptManager) {
    return NextResponse.json({ error: "Department manager access required" }, { status: 403 });
  }

  try {
    // Get department from user email domain or custom attribute
    // Admin can filter by department via query parameter
    const userEmail = session.user.email;
    const deptFilter = req.nextUrl.searchParams.get("department");
    const department = isAdmin
      ? (deptFilter ?? "all")
      : (userEmail.split("@")[1]?.split(".")[0] ?? "default");

    // Fetch department members from Cognito
    const allUsers = await listCognitoUsers();
    const members = department === "all"
      ? allUsers
      : allUsers.filter((u) => u.department === department || u.department === "default");

    // Fetch department budget from DynamoDB
    let budget: DeptBudget | null = null;
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
        const budgetResult = await dynamodb.send(
          new QueryCommand({
            TableName: DEPT_BUDGETS_TABLE,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: {
              ":pk": { S: `DEPT#${department}` },
            },
          })
        );

        if (budgetResult.Items && budgetResult.Items.length > 0) {
          const item = unmarshall(budgetResult.Items[0]);
          budget = {
            department: item.department ?? department,
            monthlyBudget: item.monthlyBudget ?? 1000,
            currentSpend: item.currentSpend ?? 0,
            monthlyTokenLimit: item.monthlyTokenLimit ?? 10000000,
            currentTokens: item.currentTokens ?? 0,
          };
        } else {
          // Return default budget if not found
          budget = {
            department,
            monthlyBudget: 1000,
            currentSpend: 0,
            monthlyTokenLimit: 10000000,
            currentTokens: 0,
          };
        }
      }
    } catch (err) {
      console.warn("[dept] Budget fetch error:", err);
      // Return default budget on error
      budget = {
        department,
        monthlyBudget: 1000,
        currentSpend: 0,
        monthlyTokenLimit: 10000000,
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

    // Format members for response
    const formattedMembers = members.map((m) => ({
      username: m.username,
      email: m.email,
      subdomain: m.subdomain,
      containerOs: m.containerOs,
      resourceTier: m.resourceTier,
      status: m.status,
    }));

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

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  // Check if user is dept-manager or admin
  const groups = session.user.groups ?? [];
  const isDeptManager = groups.includes("dept-manager") || groups.includes("admin");

  if (!isDeptManager) {
    return NextResponse.json({ error: "Department manager access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { action, requestId } = body;

    if (!action || !requestId) {
      return NextResponse.json({ error: "action and requestId required" }, { status: 400 });
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    // Update the approval request status in DynamoDB
    try {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: APPROVAL_REQUESTS_TABLE,
          Key: {
            PK: { S: `REQUEST#${requestId}` },
            SK: { S: "META" },
          },
          UpdateExpression: "SET #status = :status, updatedAt = :now, updatedBy = :user",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":status": { S: action === "approve" ? "approved" : "rejected" },
            ":now": { S: new Date().toISOString() },
            ":user": { S: session.user.email },
          },
        })
      );
    } catch (err) {
      console.error("[dept] Update request error:", err);
      // If table doesn't exist or item not found, just log and continue
    }

    // If approved, we could trigger user creation here
    // For now, just update the status

    return NextResponse.json({
      success: true,
      data: { requestId, action },
    });
  } catch (err) {
    console.error("[dept] POST", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
