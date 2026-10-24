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
import { listCognitoUsers } from "@/lib/aws-clients";
import { NORMALIZED_PER_USD } from "@/lib/budget-increase";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
const USER_BUDGETS_TABLE = process.env.USER_BUDGETS_TABLE ?? "cc-user-budgets";
const LIMITS_TABLE = process.env.LIMITS_TABLE ?? "cc-on-bedrock-limits";

// USD → normalized-token conversion for syncing $ budgets into the ADR-006(legacy 014)/015
// cc-on-bedrock-limits table. Default 66667 = 1_000_000 / $15: token-limit-enforcer
// weights are exactly list price / $15 for every model (Claude and OpenAI GPT,
// derived from bedrock-usage-tracker PRICING and test-enforced), so N USD mirrors to
// the same spend on the token axis. Only change this together with that $15 basis.
// Single source: lib/budget-increase (one-time grants convert with the same rate).

const dynamodb = new DynamoDBClient({ region });

export interface DepartmentBudget {
  department: string;
  monthlyBudget: number;         // total dept cap (USD)
  // ADR-008/023: default per-member caps (USD), used when the user sets no value for that period
  perUserDailyBudget: number;
  perUserWeeklyBudget: number;
  perUserMonthlyBudget: number;
  currentSpend: number;
  updatedAt: string;
}

export interface UserBudget {
  userId: string;
  department: string;
  dailyTokenLimit: number;       // legacy: token-based limit, kept for backward compat (ADR-006 (legacy ADR-014) normalized tokens)
  // ADR-008: explicit per-user USD caps per period; 0 = inherit (dept per-user default → global env).
  // Exceeding ANY one period blocks the user until every period is back under its cap.
  dailyBudget: number;
  weeklyBudget: number;
  monthlyBudget: number;
  currentSpend: number;          // month-to-date (written by budget-check)
  currentDailySpend: number;
  currentWeeklySpend: number;
  currentMonthlySpend: number;
  effectiveDailyBudget: number;  // resolved caps used by the last budget-check run
  effectiveWeeklyBudget: number;
  effectiveMonthlyBudget: number;
  budgetExceeded: string[];      // periods currently over cap ([] = not blocked by USD budget)
  budgetReleaseAt: string;       // ISO time the USD deny can lift ("" when not blocked)
  periodAware: boolean; // budget-check has written per-period evaluation (budgetExceeded present)
  updatedAt: string;
}

const PERIOD_FIELDS = ["dailyBudget", "weeklyBudget", "monthlyBudget"] as const;
const DEPT_PERIOD_FIELDS = ["perUserDailyBudget", "perUserWeeklyBudget", "perUserMonthlyBudget"] as const;

function isValidUsd(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000;
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
          perUserDailyBudget: Number(u.perUserDailyBudget ?? 0),
          perUserWeeklyBudget: Number(u.perUserWeeklyBudget ?? 0),
          perUserMonthlyBudget: Number(u.perUserMonthlyBudget ?? 0),  // ADR-023
          currentSpend: Number(u.currentSpend ?? 0),
          updatedAt: u.updatedAt ?? "",
        };
      });
    }

    if (!type || type === "user") {
      const [userResult, cognitoUsers] = await Promise.all([
        dynamodb.send(new ScanCommand({ TableName: USER_BUDGETS_TABLE })),
        listCognitoUsers(),
      ]);

      // Only surface budget rows that map to a real Cognito user. cc-user-budgets
      // rows are written by budget-check.py from cc-on-bedrock-usage PKs, which
      // historically could be a raw IAM principal (e.g. "awsops-ec2-role") rather
      // than a Cognito identity. Accept a row whose user_id matches any authoritative
      // Cognito identifier — sub (ADR-025), legacy subdomain, email, or username —
      // and drop everything else (stale non-user rows).
      // ADR-031 (B′): canonical key is email (lowercased). Keep sub/subdomain for
      // back-compat matching of not-yet-migrated rows; lowercase every key so a
      // mixed-case email row still matches.
      const validUserKeys = new Set<string>();
      for (const cu of cognitoUsers) {
        if (cu.sub) validUserKeys.add(cu.sub.toLowerCase());
        if (cu.subdomain) validUserKeys.add(cu.subdomain.toLowerCase());
        if (cu.email) validUserKeys.add(cu.email.toLowerCase());
        if (cu.username) validUserKeys.add(cu.username.toLowerCase());
      }

      results.users = (userResult.Items ?? [])
        .map((item) => {
          const u = unmarshall(item);
          return {
            userId: u.user_id ?? u.userId ?? u.PK?.replace("USER#", "") ?? "unknown",
            department: u.department ?? "default",
            dailyTokenLimit: Number(u.dailyTokenLimit ?? 100000),
            dailyBudget: Number(u.dailyBudget ?? 0),
            weeklyBudget: Number(u.weeklyBudget ?? 0),
            monthlyBudget: Number(u.monthlyBudget ?? 0),
            currentSpend: Number(u.currentSpend ?? 0),
            currentDailySpend: Number(u.currentDailySpend ?? 0),
            currentWeeklySpend: Number(u.currentWeeklySpend ?? 0),
            currentMonthlySpend: Number(u.currentMonthlySpend ?? u.currentSpend ?? 0),
            effectiveDailyBudget: Number(u.effectiveDailyBudget ?? 0),
            effectiveWeeklyBudget: Number(u.effectiveWeeklyBudget ?? 0),
            effectiveMonthlyBudget: Number(u.effectiveMonthlyBudget ?? 0),
            budgetExceeded: Array.isArray(u.budgetExceeded) ? u.budgetExceeded.map(String) : [],
            budgetReleaseAt: String(u.budgetReleaseAt ?? ""),
            periodAware: Array.isArray(u.budgetExceeded),
            updatedAt: u.updatedAt ?? "",
          };
        })
        .filter((u) => validUserKeys.has(String(u.userId).toLowerCase()));
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
    const { type, id, monthlyBudget, dailyTokenLimit, allowedTiers } = body as {
      type: "department" | "user";
      id: string;
      monthlyBudget?: number;
      dailyBudget?: number;           // user-only
      weeklyBudget?: number;          // user-only
      perUserDailyBudget?: number;    // dept-only (ADR-008/023 per-member defaults)
      perUserWeeklyBudget?: number;
      perUserMonthlyBudget?: number;
      dailyTokenLimit?: number;
      allowedTiers?: string[];
    };

    if (!type || !id) {
      return NextResponse.json({ error: "type and id are required" }, { status: 400 });
    }
    // Every USD field present must be a finite, non-negative number (0 = inherit / no cap).
    for (const f of [...PERIOD_FIELDS, ...DEPT_PERIOD_FIELDS]) {
      const v = (body as Record<string, unknown>)[f];
      if (v !== undefined && !isValidUsd(v)) {
        return NextResponse.json({ error: `${f} must be a number between 0 and 1000000` }, { status: 400 });
      }
    }

    const now = new Date().toISOString();

    if (type === "department") {
      // ADR-023: dept rows carry `monthlyBudget` (total cap) plus per-member default
      // caps per period (ADR-008: daily / weekly / monthly). At least one must be set.
      const deptFields = DEPT_PERIOD_FIELDS.filter((f) => (body as Record<string, unknown>)[f] !== undefined);
      if (monthlyBudget === undefined && deptFields.length === 0) {
        return NextResponse.json({ error: "monthlyBudget or a perUser*Budget field is required" }, { status: 400 });
      }
      const updateParts: string[] = ["updatedAt = :now"];
      const exprVals: Record<string, { N: string } | { S: string } | { L: { S: string }[] }> = {
        ":now": { S: now },
      };
      if (monthlyBudget !== undefined) {
        updateParts.push("monthlyBudget = :budget");
        exprVals[":budget"] = { N: String(monthlyBudget) };
      }
      for (const f of deptFields) {
        updateParts.push(`${f} = :${f}`);
        exprVals[`:${f}`] = { N: String((body as Record<string, number>)[f]) };
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
      // ADR-031 (B′): the per-user canonical key is the lowercased email. Normalize
      // once so BOTH the cc-user-budgets row AND the mirrored LIMIT#monthly land
      // under USER#{email.lower()} — matching the tracker/enforcer key (else the
      // enforcer can't read the mirrored cap → token-limit bypass).
      const userId = id.trim().toLowerCase();
      const updateParts: string[] = ["updatedAt = :now"];
      const exprValues: Record<string, AttributeValue> = {
        ":now": { S: now },
      };

      for (const f of PERIOD_FIELDS) {
        const v = (body as Record<string, unknown>)[f];
        if (v !== undefined) {
          updateParts.push(`${f} = :${f}`);
          exprValues[`:${f}`] = { N: String(v) };
        }
      }
      if (dailyTokenLimit !== undefined) {
        updateParts.push("dailyTokenLimit = :limit");
        exprValues[":limit"] = { N: String(dailyTokenLimit) };
      }

      if (updateParts.length === 1) {
        return NextResponse.json({ error: "dailyBudget, weeklyBudget, monthlyBudget or dailyTokenLimit required" }, { status: 400 });
      }

      await dynamodb.send(new UpdateItemCommand({
        TableName: USER_BUDGETS_TABLE,
        Key: { user_id: { S: userId } },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
      }));

      // ADR-006(legacy 014)/015: mirror $ monthlyBudget into cc-on-bedrock-limits LIMIT#monthly so
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
              PK: { S: `USER#${userId}` },
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
          // DynamoDB DeleteItem is a no-op when the item doesn't exist (it does
          // NOT throw ResourceNotFoundException for missing rows — that exception
          // is reserved for missing tables). Any other error (throttling,
          // AccessDenied, network) must propagate to the outer catch so the PUT
          // returns 500: swallowing here would let cc-user-budgets.monthlyBudget=0
          // commit while LIMIT#monthly keeps the stale cap, leaving
          // token-limit-enforcer blocking the user on an old threshold.
          await dynamodb.send(new DeleteItemCommand({
            TableName: LIMITS_TABLE,
            Key: {
              PK: { S: `USER#${userId}` },
              SK: { S: "LIMIT#monthly" },
            },
          }));
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
