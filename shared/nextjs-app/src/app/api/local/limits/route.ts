import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DynamoDBClient, ScanCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

// ADR-014: returns the current normalized-token usage and limits for the logged-in user
// across daily / weekly / monthly periods, plus department aggregates.

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const LIMITS_TABLE = process.env.LIMITS_TABLE ?? "cc-on-bedrock-limits";
const USER_BUDGETS_TABLE = process.env.USER_BUDGETS_TABLE ?? "cc-user-budgets";

const dynamo = new DynamoDBClient({ region });

type PeriodSummary = {
  period: "daily" | "weekly" | "monthly";
  userUsed: number;
  userLimit: number;
  deptUsed: number;
  deptLimit: number;
  resetAt: string | null;
};

function kstNow(): Date {
  const utc = new Date();
  return new Date(utc.getTime() + 9 * 60 * 60 * 1000);
}

function bucketFor(d: Date, period: PeriodSummary["period"]): string {
  if (period === "daily") return d.toISOString().slice(0, 10);
  if (period === "monthly") return d.toISOString().slice(0, 7);
  // weekly: ISO week (year-Wnn)
  const day = (d.getUTCDay() + 6) % 7; // Monday=0
  const thu = new Date(d);
  thu.setUTCDate(d.getUTCDate() - day + 3);
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const week = Math.floor(((thu.getTime() - yearStart.getTime()) / 86400000 + 1) / 7) + 1;
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function nextResetIso(period: PeriodSummary["period"]): string {
  const now = kstNow();
  let nxt: Date;
  if (period === "daily") {
    nxt = new Date(now);
    nxt.setUTCDate(now.getUTCDate() + 1);
    nxt.setUTCHours(0, 0, 0, 0);
  } else if (period === "weekly") {
    nxt = new Date(now);
    const day = (now.getUTCDay() + 6) % 7;
    const daysAhead = (7 - day) % 7 || 7;
    nxt.setUTCDate(now.getUTCDate() + daysAhead);
    nxt.setUTCHours(0, 0, 0, 0);
  } else {
    nxt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }
  // back to UTC by subtracting +9h KST offset
  nxt.setTime(nxt.getTime() - 9 * 60 * 60 * 1000);
  return nxt.toISOString().replace(/\.\d+Z$/, "Z");
}

// USD budget deny (cc-bedrock-user-daily-deny) releases when the daily spend window rolls
// over — i.e. the next UTC midnight — OR within ~5 min of an admin raising the budget
// (budget-check re-evaluates every 5 min). We surface the guaranteed-by time.
function nextUtcMidnightIso(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString().replace(/\.\d+Z$/, "Z");
}

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  // ADR-031 (B′): usage/limits canonical key = email (lowercased), not Cognito sub.
  const userKey = (session.user.email ?? "").trim().toLowerCase();
  const dept = (session.user as { department?: string }).department ?? "default";
  if (!userKey) {
    return NextResponse.json({ error: "email missing from session" }, { status: 400 });
  }

  try {
    // Single scan; the table is small (per-user/per-dept rows).
    const all = await dynamo.send(new ScanCommand({ TableName: LIMITS_TABLE }));
    const items = (all.Items ?? []).map((it) => unmarshall(it));

    const periods: PeriodSummary["period"][] = ["daily", "weekly", "monthly"];
    const now = kstNow();
    const summary: PeriodSummary[] = [];
    let denyActive: { reason?: string; resetAt?: string; period?: string } | null = null;

    for (const p of periods) {
      const bucket = bucketFor(now, p);
      const userCounterSk = `COUNTER#${p}#${bucket}`;
      const userCounter = items.find((i) => i.PK === `USER#${userKey}` && i.SK === userCounterSk);
      const userLimit = items.find((i) => i.PK === `USER#${userKey}` && i.SK === `LIMIT#${p}`);
      const deptCounter = items.find((i) => i.PK === `DEPT#${dept}` && i.SK === userCounterSk);
      const deptLimit = items.find((i) => i.PK === `DEPT#${dept}` && i.SK === `LIMIT#${p}`);

      summary.push({
        period: p,
        userUsed: Number(userCounter?.normalized ?? 0),
        userLimit: Number(userLimit?.max_normalized ?? 0),
        deptUsed: Number(deptCounter?.normalized ?? 0),
        deptLimit: Number(deptLimit?.max_normalized ?? 0),
        resetAt: nextResetIso(p),
      });
    }

    const denyItem = items.find((i) => i.PK === `USER#${userKey}` && i.SK === "DENY#active");
    if (denyItem) {
      denyActive = {
        reason: String(denyItem.reason ?? ""),
        resetAt: String(denyItem.reset_at ?? ""),
        period: String(denyItem.period ?? ""),
      };
    }

    // USD budget deny (cc-bedrock-user-daily-deny, ADR-015) — not in the limits
    // table, so read the budget row and surface a release estimate to the user.
    // ADR-031 (B′): cc-user-budgets is keyed by email; legacy rows may still be
    // keyed by subdomain, so fall back to it.
    let budgetDeny: { active: boolean; currentSpend: number; budget: number; releaseAt: string } | null = null;
    const subdomain = (session.user as { subdomain?: string }).subdomain;
    const budgetKeys = [userKey, ...(subdomain && subdomain !== userKey ? [subdomain] : [])];
    try {
      for (const budgetKey of budgetKeys) {
        const r = await dynamo.send(new GetItemCommand({
          TableName: USER_BUDGETS_TABLE,
          Key: { user_id: { S: budgetKey } },
        }));
        if (!r.Item) continue;
        const b = unmarshall(r.Item);
        const budget = Number(b.monthlyBudget ?? 0);
        const spend = Number(b.currentSpend ?? 0);
        if (budget > 0 && spend >= budget) {
          budgetDeny = { active: true, currentSpend: spend, budget, releaseAt: nextUtcMidnightIso() };
        }
        break; // first existing row wins (canonical email key preferred)
      }
    } catch {
      /* budget table optional — ignore */
    }

    return NextResponse.json({ user: userKey, department: dept, summary, denyActive, budgetDeny });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "lookup failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
