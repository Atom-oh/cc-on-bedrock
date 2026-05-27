import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
const USER_BUDGETS_TABLE = process.env.USER_BUDGETS_TABLE ?? "cc-user-budgets";
const LIMITS_TABLE = process.env.LIMITS_TABLE ?? "cc-on-bedrock-limits";

// USD → normalized-token conversion for syncing $ budgets into the ADR-014/015
// cc-on-bedrock-limits table. Default 66667 ≈ Sonnet output ($15 / 1M tokens, weight 1.0):
// $1 ≈ 1_000_000 / 15 ≈ 66_667 normalized. Override with NORMALIZED_PER_USD when the
// expected workload mix shifts (Opus-heavy or Haiku-heavy).
const NORMALIZED_PER_USD = Number(process.env.NORMALIZED_PER_USD ?? "66667");

const dynamodb = new DynamoDBClient({ region });

export interface DepartmentBudget {
  department: string;
  monthlyBudget: number;         // total dept cap (USD)
  perUserMonthlyBudget: number;  // ADR-023: default per-member cap, used when user has no explicit budget
  currentSpend: number;
  updatedAt: string;
}

export interface UserBudget {
  userId: string;
  department: string;
  dailyTokenLimit: number;       // legacy: token-based limit, kept for backward compat (ADR-014 normalized tokens)
  monthlyBudget: number;         // explicit per-user USD cap; 0 means inherit from dept.perUserMonthlyBudget
  currentSpend: number;
  updatedAt: string;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type"); // "department" | "user" | undefined (both)

  try {
    const results: { departments?: DepartmentBudget[]; users?: UserBudget[] } = {};

    if (!type || type === "department") {
      const deptResult = await dynamodb.send(new ScanCommand({
        TableName: DEPT_BUDGETS_TABLE,
      }));
      results.departments = (deptResult.Items ?? []).map((item) => {
        const u = unmarshall(item);
        return {
          department: u.dept_id ?? u.department ?? u.PK?.replace("DEPT#", "") ?? "unknown",
          monthlyBudget: Number(u.monthlyBudget ?? 0),
          perUserMonthlyBudget: Number(u.perUserMonthlyBudget ?? 0),  // ADR-023
          currentSpend: Number(u.currentSpend ?? 0),
          updatedAt: u.updatedAt ?? "",
        };
      });
    }

    if (!type || type === "user") {
      const userResult = await dynamodb.send(new ScanCommand({
        TableName: USER_BUDGETS_TABLE,
      }));
      results.users = (userResult.Items ?? []).map((item) => {
        const u = unmarshall(item);
        return {
          userId: u.user_id ?? u.userId ?? u.PK?.replace("USER#", "") ?? "unknown",
          department: u.department ?? "default",
          dailyTokenLimit: Number(u.dailyTokenLimit ?? 100000),
          monthlyBudget: Number(u.monthlyBudget ?? 0),
          currentSpend: Number(u.currentSpend ?? 0),
          updatedAt: u.updatedAt ?? "",
        };
      });
    }

    return NextResponse.json({
      success: true,
      data: results,
    });
  } catch (err) {
    console.error("[admin/budgets] GET", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { type, id, monthlyBudget, perUserMonthlyBudget, dailyTokenLimit, allowedTiers } = body as {
      type: "department" | "user";
      id: string;
      monthlyBudget?: number;
      perUserMonthlyBudget?: number;  // ADR-023: dept-only field
      dailyTokenLimit?: number;
      allowedTiers?: string[];
    };

    if (!type || !id) {
      return NextResponse.json({ error: "type and id are required" }, { status: 400 });
    }

    const now = new Date().toISOString();

    if (type === "department") {
      // ADR-023: dept rows now carry two budget knobs — `monthlyBudget` (total cap)
      // and `perUserMonthlyBudget` (default per-member cap). At least one must be set.
      if (monthlyBudget === undefined && perUserMonthlyBudget === undefined) {
        return NextResponse.json({ error: "monthlyBudget or perUserMonthlyBudget is required" }, { status: 400 });
      }
      const updateParts: string[] = ["updatedAt = :now"];
      const exprVals: Record<string, { N: string } | { S: string } | { L: { S: string }[] }> = {
        ":now": { S: now },
      };
      if (monthlyBudget !== undefined) {
        updateParts.push("monthlyBudget = :budget");
        exprVals[":budget"] = { N: String(monthlyBudget) };
      }
      if (perUserMonthlyBudget !== undefined) {
        updateParts.push("perUserMonthlyBudget = :perUser");
        exprVals[":perUser"] = { N: String(perUserMonthlyBudget) };
      }
      if (allowedTiers && Array.isArray(allowedTiers)) {
        updateParts.push("allowedTiers = :tiers");
        exprVals[":tiers"] = { L: allowedTiers.map(t => ({ S: t })) };
      }
      await dynamodb.send(new UpdateItemCommand({
        TableName: DEPT_BUDGETS_TABLE,
        Key: { dept_id: { S: id } },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ExpressionAttributeValues: exprVals,
      }));
    } else if (type === "user") {
      const updateParts: string[] = ["updatedAt = :now"];
      const exprValues: Record<string, AttributeValue> = {
        ":now": { S: now },
      };

      if (monthlyBudget !== undefined) {
        updateParts.push("monthlyBudget = :budget");
        exprValues[":budget"] = { N: String(monthlyBudget) };
      }
      if (dailyTokenLimit !== undefined) {
        updateParts.push("dailyTokenLimit = :limit");
        exprValues[":limit"] = { N: String(dailyTokenLimit) };
      }

      if (updateParts.length === 1) {
        return NextResponse.json({ error: "monthlyBudget or dailyTokenLimit required" }, { status: 400 });
      }

      await dynamodb.send(new UpdateItemCommand({
        TableName: USER_BUDGETS_TABLE,
        Key: { user_id: { S: id } },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
      }));

      // ADR-014/015: mirror $ monthlyBudget into cc-on-bedrock-limits LIMIT#monthly so
      // the Stream-driven token-limit-enforcer (near-real-time) can enforce it on the
      // Local Governance role. Without this, the only enforcement path is budget-check
      // (5-min cron) which used to silently skip Local-only users.
      // monthlyBudget > 0 → upsert LIMIT row; monthlyBudget === 0 → delete row so
      // dept.perUserMonthlyBudget (ADR-023) takes over.
      if (monthlyBudget !== undefined) {
        if (monthlyBudget > 0) {
          const maxNormalized = Math.floor(monthlyBudget * NORMALIZED_PER_USD);
          await dynamodb.send(new UpdateItemCommand({
            TableName: LIMITS_TABLE,
            Key: {
              PK: { S: `USER#${id}` },
              SK: { S: "LIMIT#monthly" },
            },
            UpdateExpression: "SET max_normalized = :mx, source_usd = :usd, normalized_per_usd = :rate, updatedAt = :now",
            ExpressionAttributeValues: {
              ":mx": { N: String(maxNormalized) },
              ":usd": { N: String(monthlyBudget) },
              ":rate": { N: String(NORMALIZED_PER_USD) },
              ":now": { S: now },
            },
          }));
        } else {
          try {
            await dynamodb.send(new DeleteItemCommand({
              TableName: LIMITS_TABLE,
              Key: {
                PK: { S: `USER#${id}` },
                SK: { S: "LIMIT#monthly" },
              },
            }));
          } catch (err) {
            // Treat "row didn't exist" as success; surface anything else.
            const code = (err as { name?: string }).name;
            if (code !== "ResourceNotFoundException") {
              console.warn("[admin/budgets] LIMIT#monthly delete:", err instanceof Error ? err.message : err);
            }
          }
        }
      }
    } else {
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: `${type} budget updated`,
    });
  } catch (err) {
    console.error("[admin/budgets] PUT", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
