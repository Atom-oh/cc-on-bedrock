import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { getCognitoUser, listCognitoUsers } from "@/lib/aws-clients";
import { requireFreshRole } from "@/lib/role-admin";
import { syncMonthlyLimitMirror } from "@/lib/limit-mirror";
import { applyLimitChange, pickNumbers, type LimitChange } from "@/lib/limit-audit";
import { budgetStatus, readTokenDeniedUsers, type PeriodStatus } from "@/lib/budget-status";
import type { BlockCause } from "@/lib/budget-display";
import type { BudgetPeriod } from "@/lib/budget-periods";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const DEPT_BUDGETS_TABLE = process.env.DEPT_BUDGETS_TABLE ?? "cc-department-budgets";
const USER_BUDGETS_TABLE = process.env.USER_BUDGETS_TABLE ?? "cc-user-budgets";

// USD → normalized-token conversion for the LIMIT#monthly mirror (lib/limit-mirror,
// rate from lib/budget-increase NORMALIZED_PER_USD). Default 66667 = 1_000_000 / $15:
// token-limit-enforcer weights are exactly list price / $15 for every model (Claude
// and OpenAI GPT, derived from bedrock-usage-tracker PRICING and test-enforced), so
// N USD mirrors to the same spend on the token axis. Only change this together with
// that $15 basis. One-time grants convert with the same rate.

const dynamodb = new DynamoDBClient({ region });

export interface DepartmentBudget {
  department: string;
  monthlyBudget: number;         // total dept cap (USD)
  // ADR-008/023: default per-member caps (USD), used when the user sets no value for that period
  perUserDailyBudget: number;
  perUserWeeklyBudget: number;
  perUserMonthlyBudget: number;
  // ADR-008 amendment: members without an explicit cap are uncapped (overrides the
  // per-user defaults above and the global env default).
  unlimitedPerUser: boolean;
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
  // Caps as "base + current one-time grant" and why the user is blocked (null = not blocked).
  periods: Record<BudgetPeriod, PeriodStatus>;
  tokenDenied: boolean;
  departmentOver: boolean;
  blockCause: BlockCause;
}

const PERIOD_FIELDS = ["dailyBudget", "weeklyBudget", "monthlyBudget"] as const;
const DEPT_PERIOD_FIELDS = ["perUserDailyBudget", "perUserWeeklyBudget", "perUserMonthlyBudget"] as const;

function isValidUsd(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000;
}

/** Target user's department for the audit record (fresh from Cognito); "" when unknown. */
async function auditDepartment(email: string): Promise<string> {
  try {
    return (await getCognitoUser(email)).department ?? "";
  } catch (err) {
    console.warn("[admin/budgets] audit department lookup failed:", err instanceof Error ? err.message : err);
    return "";
  }
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

    // Department rows are needed for both views (user caps inherit per-user defaults).
    const deptResult = await dynamodb.send(new ScanCommand({
      TableName: DEPT_BUDGETS_TABLE,
    }));
    const deptRows = new Map<string, Record<string, unknown>>();
    for (const item of deptResult.Items ?? []) {
      const u = unmarshall(item);
      deptRows.set(String(u.dept_id ?? u.department ?? ""), u);
    }

    if (!type || type === "department") {
      results.departments = (deptResult.Items ?? []).map((item) => {
        const u = unmarshall(item);
        return {
          department: u.dept_id ?? u.department ?? u.PK?.replace("DEPT#", "") ?? "unknown",
          monthlyBudget: Number(u.monthlyBudget ?? 0),
          perUserDailyBudget: Number(u.perUserDailyBudget ?? 0),
          perUserWeeklyBudget: Number(u.perUserWeeklyBudget ?? 0),
          perUserMonthlyBudget: Number(u.perUserMonthlyBudget ?? 0),  // ADR-023
          unlimitedPerUser: u.unlimitedPerUser === true,
          currentSpend: Number(u.currentSpend ?? 0),
          updatedAt: u.updatedAt ?? "",
        };
      });
    }

    if (!type || type === "user") {
      const [userResult, cognitoUsers, tokenDenied] = await Promise.all([
        dynamodb.send(new ScanCommand({ TableName: USER_BUDGETS_TABLE })),
        listCognitoUsers(),
        // Best-effort: without it the token cause is just not shown.
        readTokenDeniedUsers().catch((err) => {
          console.warn("[admin/budgets] token deny scan failed:", err instanceof Error ? err.message : err);
          return new Set<string>();
        }),
      ]);
      const now = new Date();

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
          const userId = String(u.user_id ?? u.userId ?? u.PK?.replace("USER#", "") ?? "unknown");
          const status = budgetStatus(u, deptRows.get(String(u.department ?? "")), now, tokenDenied.has(userId.toLowerCase()));
          return {
            userId,
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
            periods: status.periods,
            tokenDenied: status.tokenDenied,
            departmentOver: status.departmentOver,
            blockCause: status.blockCause,
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
  // The session's groups can be up to 8h stale: re-check the CURRENT role before writing.
  const fresh = await requireFreshRole(session, ["admin"]);
  if (!fresh.ok) return fresh.response;

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
      unlimitedPerUser?: boolean;     // dept-only (ADR-008 amendment)
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
    const unlimitedPerUser = (body as Record<string, unknown>).unlimitedPerUser;
    if (unlimitedPerUser !== undefined && typeof unlimitedPerUser !== "boolean") {
      return NextResponse.json({ error: "unlimitedPerUser must be a boolean" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const actor: Pick<LimitChange, "actor" | "actorRole" | "appliedAt"> = {
      actor: session.user.email,
      actorRole: fresh.role,
      appliedAt: now,
    };

    if (type === "department") {
      // ADR-023: dept rows carry `monthlyBudget` (total cap) plus per-member default
      // caps per period (ADR-008: daily / weekly / monthly). At least one must be set.
      const deptFields = DEPT_PERIOD_FIELDS.filter((f) => (body as Record<string, unknown>)[f] !== undefined);
      if (monthlyBudget === undefined && deptFields.length === 0 && unlimitedPerUser === undefined) {
        return NextResponse.json({ error: "monthlyBudget, a perUser*Budget field or unlimitedPerUser is required" }, { status: 400 });
      }
      const updateParts: string[] = ["updatedAt = :now"];
      const exprVals: Record<string, { N: string } | { S: string } | { BOOL: boolean } | { L: { S: string }[] }> = {
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
      if (unlimitedPerUser !== undefined) {
        updateParts.push("unlimitedPerUser = :unlimitedPerUser");
        exprVals[":unlimitedPerUser"] = { BOOL: unlimitedPerUser };
      }
      if (allowedTiers && Array.isArray(allowedTiers)) {
        updateParts.push("allowedTiers = :tiers");
        exprVals[":tiers"] = { L: allowedTiers.map(t => ({ S: t })) };
      }
      const Key = { dept_id: { S: id } };
      const current = await dynamodb.send(new GetItemCommand({ TableName: DEPT_BUDGETS_TABLE, Key }));
      const changed = [...(monthlyBudget !== undefined ? ["monthlyBudget"] : []), ...deptFields];
      // The audit stores numbers: unlimitedPerUser is recorded as 1 (on) / 0 (off).
      // A row without the attribute is "off" (budget-check reads only a real true), so
      // the first toggle audits 0 → 1 rather than a missing "before".
      const flagAudit = (row: Record<string, unknown> | undefined): Record<string, number> =>
        unlimitedPerUser !== undefined ? { unlimitedPerUser: row?.unlimitedPerUser === true ? 1 : 0 } : {};
      // Row update + limit_change audit commit together (lib/limit-audit).
      await applyLimitChange(
        {
          TableName: DEPT_BUDGETS_TABLE,
          Key,
          UpdateExpression: `SET ${updateParts.join(", ")}`,
          ExpressionAttributeValues: exprVals,
        },
        {
          ...actor,
          targetType: "department",
          department: id,
          before: {
            ...pickNumbers(current.Item ? unmarshall(current.Item) : undefined, changed),
            ...flagAudit(current.Item ? unmarshall(current.Item) : undefined),
          },
          after: { ...pickNumbers(body as Record<string, unknown>, changed), ...flagAudit(body as Record<string, unknown>) },
        }
      );
    } else if (type === "user") {
      // ADR-031 (B′): the per-user canonical key is the lowercased email. Normalize
      // once so BOTH the cc-user-budgets row AND the mirrored LIMIT#monthly land
      // under USER#{email.lower()} — matching the tracker/enforcer key (else the
      // enforcer can't read the mirrored cap → token-limit bypass).
      if (unlimitedPerUser !== undefined) {
        return NextResponse.json({ error: "unlimitedPerUser applies to departments only" }, { status: 400 });
      }
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

      const Key = { user_id: { S: userId } };
      const current = await dynamodb.send(new GetItemCommand({ TableName: USER_BUDGETS_TABLE, Key }));
      const changed = [
        ...PERIOD_FIELDS.filter((f) => (body as Record<string, unknown>)[f] !== undefined),
        ...(dailyTokenLimit !== undefined ? ["dailyTokenLimit"] : []),
      ];
      // Row update + limit_change audit commit together (lib/limit-audit).
      await applyLimitChange(
        {
          TableName: USER_BUDGETS_TABLE,
          Key,
          UpdateExpression: `SET ${updateParts.join(", ")}`,
          ExpressionAttributeValues: exprValues,
        },
        {
          ...actor,
          targetType: "user",
          email: userId,
          department: await auditDepartment(userId),
          before: pickNumbers(current.Item ? unmarshall(current.Item) : undefined, changed),
          after: pickNumbers(body as Record<string, unknown>, changed),
        }
      );

      // monthlyBudget > 0 → upsert LIMIT#monthly; 0 → delete it (lib/limit-mirror).
      if (monthlyBudget !== undefined) {
        await syncMonthlyLimitMirror(userId, monthlyBudget, now);
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
