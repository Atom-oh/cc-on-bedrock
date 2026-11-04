// Session insights read side (admin Overview). Session rows are client-reported by
// cc-bedrock-local and written by the usage tracker into SESSIONS_TABLE; the daily
// Haiku insight row is written by the session-insights Lambda. Insight only: metered
// cost (budgets) comes from the usage table (ADR-005), read via usage-client.
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getTotalUsage } from "./usage-client";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
// Unset (local dev) = default name; set to "" by Terraform when enable_session_insights = false.
const SESSIONS_TABLE = process.env.SESSIONS_TABLE ?? "cc-on-bedrock-sessions";

/** False when Terraform disabled the feature (SESSIONS_TABLE set to an empty string). */
export function sessionInsightsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SESSIONS_TABLE ?? "cc-on-bedrock-sessions").trim() !== "";
}
const DATE_INDEX = "date-index";
const INSIGHT_PK = "INSIGHT#daily";
const MAX_PAGES = 50;

const dynamodb = new DynamoDBClient({ region });
type Send = (command: QueryCommand | GetItemCommand) => Promise<{
  Items?: Record<string, AttributeValue>[];
  Item?: Record<string, AttributeValue>;
  LastEvaluatedKey?: Record<string, AttributeValue>;
}>;
const defaultSend: Send = (command) =>
  (dynamodb.send as (c: unknown) => Promise<Awaited<ReturnType<Send>>>)(command);

// ─── Types ───

export type SessionToolName = "claude" | "codex";

export interface SessionRow {
  email: string;
  department: string;
  tool: SessionToolName;
  sessionId: string;
  date: string;
  turns: number;
  requests: number;
  estimatedCost: number;
}

export interface ToolSplit {
  sessions: number;
  turns: number;
  estimatedCost: number;
}

export interface SessionTotals {
  sessions: number;
  turns: number;
  requests: number;
  estimatedCost: number;
  costPerTurn: number;
  costPerSession: number;
  avgTurnsPerSession: number;
}

export interface SessionTopUser {
  email: string;
  department: string;
  sessions: number;
  turns: number;
  estimatedCost: number;
  costPerTurn: number;
  costPerSession: number;
  tools: Record<SessionToolName, ToolSplit>;
}

export interface SessionDailyPoint {
  date: string;
  sessions: number;
  turns: number;
  estimatedCost: number;
}

export interface SessionAggregate {
  totals: SessionTotals;
  topUsers: SessionTopUser[];
  daily: SessionDailyPoint[];
}

export type InsightSeverity = "info" | "watch" | "action";

export interface InsightFinding {
  /** Email the label maps to, or the raw label when it is unknown. */
  user: string;
  label: string;
  severity: InsightSeverity;
  title: string;
  detail: string;
  suggestion: string;
}

export interface SessionInsight {
  date: string;
  generatedAt: string;
  model: string;
  status: "ok" | "error";
  error?: string;
  summary: string;
  findings: InsightFinding[];
  fleet: string[];
}

export interface SessionInsightsResponse extends SessionAggregate {
  enabled: true;
  range: { start: string; end: string };
  metered: { estimatedCost: number };
  /** Reported session cost / metered cost; null when nothing is metered. */
  coverage: number | null;
  insight: SessionInsight | null;
}

// ─── Pure helpers ───

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0);

/** Normalize an unmarshalled DynamoDB item into a SessionRow, or null if it is not one. */
export function toSessionRow(item: Record<string, unknown>): SessionRow | null {
  const email = typeof item.email === "string" && item.email
    ? item.email
    : typeof item.PK === "string" && item.PK.startsWith("USER#") ? item.PK.slice(5) : "";
  const tool = item.tool === "claude" || item.tool === "codex" ? item.tool : null;
  const sessionId = typeof item.sessionId === "string" ? item.sessionId : "";
  const date = typeof item.date === "string" ? item.date : typeof item.gsiDate === "string" ? item.gsiDate : "";
  if (!email || !tool || !sessionId || !date) return null;
  return {
    email: email.toLowerCase(),
    department: typeof item.department === "string" && item.department ? item.department : "default",
    tool,
    sessionId,
    date,
    turns: num(item.turns),
    requests: num(item.requests),
    estimatedCost: num(item.estimatedCost),
  };
}

/** Inclusive list of YYYY-MM-DD dates from start to end (UTC). */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last && out.length < 366) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Aggregate session bucket rows. A session spanning several UTC days has one row per
 * day: range totals and per-user counts count distinct (user, tool, sessionId), while
 * the daily series counts that day's buckets. `dates` zero-fills the daily series.
 */
export function aggregateSessions(
  rows: SessionRow[],
  opts: { topN?: number; dates?: string[] } = {}
): SessionAggregate {
  const topN = opts.topN ?? 10;
  const emptySplit = (): ToolSplit => ({ sessions: 0, turns: 0, estimatedCost: 0 });

  const allSessions = new Set<string>();
  let turns = 0;
  let requests = 0;
  let cost = 0;

  interface Acc {
    email: string;
    department: string;
    sessions: Set<string>;
    turns: number;
    cost: number;
    tools: Record<SessionToolName, { sessions: Set<string>; turns: number; cost: number }>;
  }
  const users = new Map<string, Acc>();
  const daily = new Map<string, { sessions: Set<string>; turns: number; cost: number }>();
  for (const d of opts.dates ?? []) daily.set(d, { sessions: new Set(), turns: 0, cost: 0 });

  for (const r of rows) {
    const sessionKey = `${r.email}#${r.tool}#${r.sessionId}`;
    allSessions.add(sessionKey);
    turns += r.turns;
    requests += r.requests;
    cost += r.estimatedCost;

    let u = users.get(r.email);
    if (!u) {
      u = {
        email: r.email,
        department: r.department,
        sessions: new Set(),
        turns: 0,
        cost: 0,
        tools: {
          claude: { sessions: new Set(), turns: 0, cost: 0 },
          codex: { sessions: new Set(), turns: 0, cost: 0 },
        },
      };
      users.set(r.email, u);
    }
    u.sessions.add(sessionKey);
    u.turns += r.turns;
    u.cost += r.estimatedCost;
    const t = u.tools[r.tool];
    t.sessions.add(sessionKey);
    t.turns += r.turns;
    t.cost += r.estimatedCost;

    let day = daily.get(r.date);
    if (!day) {
      day = { sessions: new Set(), turns: 0, cost: 0 };
      daily.set(r.date, day);
    }
    day.sessions.add(sessionKey);
    day.turns += r.turns;
    day.cost += r.estimatedCost;
  }

  const sessions = allSessions.size;
  const topUsers: SessionTopUser[] = Array.from(users.values())
    .sort((a, b) => b.cost - a.cost || a.email.localeCompare(b.email))
    .slice(0, Math.max(0, topN))
    .map((u) => {
      const tools = { claude: emptySplit(), codex: emptySplit() };
      for (const k of ["claude", "codex"] as const) {
        tools[k] = { sessions: u.tools[k].sessions.size, turns: u.tools[k].turns, estimatedCost: u.tools[k].cost };
      }
      return {
        email: u.email,
        department: u.department,
        sessions: u.sessions.size,
        turns: u.turns,
        estimatedCost: u.cost,
        costPerTurn: ratio(u.cost, u.turns),
        costPerSession: ratio(u.cost, u.sessions.size),
        tools,
      };
    });

  return {
    totals: {
      sessions,
      turns,
      requests,
      estimatedCost: cost,
      costPerTurn: ratio(cost, turns),
      costPerSession: ratio(cost, sessions),
      avgTurnsPerSession: ratio(turns, sessions),
    },
    topUsers,
    daily: Array.from(daily.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, sessions: d.sessions.size, turns: d.turns, estimatedCost: d.cost })),
  };
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * Parse an insight row defensively (stats/insight/labels are JSON strings written by the
 * Lambda from model output) and map the pseudonymous labels U1.. back to emails, both in
 * `findings[].user` and inside the free text.
 */
export function parseInsightRow(item: Record<string, unknown> | null | undefined): SessionInsight | null {
  if (!item || typeof item !== "object") return null;
  const rawLabels = parseJson(item.labels);
  const labels: Record<string, string> = {};
  if (rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)) {
    for (const [k, v] of Object.entries(rawLabels)) {
      if (/^U\d{1,3}$/.test(k) && typeof v === "string" && v) labels[k] = v;
    }
  }
  const unlabel = (s: string) => s.replace(/\bU\d{1,3}\b/g, (m) => labels[m] ?? m);

  const insight = parseJson(item.insight);
  const ins = insight && typeof insight === "object" && !Array.isArray(insight)
    ? (insight as Record<string, unknown>)
    : {};
  const findings: InsightFinding[] = (Array.isArray(ins.findings) ? ins.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && !Array.isArray(f))
    .slice(0, 8)
    .map((f) => {
      const label = str(f.user, 16);
      const severity: InsightSeverity =
        f.severity === "watch" || f.severity === "action" ? f.severity : "info";
      return {
        user: labels[label] ?? label,
        label,
        severity,
        title: unlabel(str(f.title, 300)),
        detail: unlabel(str(f.detail)),
        suggestion: unlabel(str(f.suggestion)),
      };
    });
  const fleet = (Array.isArray(ins.fleet) ? ins.fleet : [])
    .filter((s): s is string => typeof s === "string")
    .slice(0, 10)
    .map((s) => unlabel(s.slice(0, 1000)));

  const status = item.status === "ok" ? "ok" : "error";
  const out: SessionInsight = {
    date: str(item.date ?? item.SK, 10),
    generatedAt: str(item.generatedAt, 40),
    model: str(item.model, 200),
    status,
    summary: unlabel(str(ins.summary, 4000)),
    findings,
    fleet,
  };
  if (status === "error") out.error = str(item.error, 1000) || "Insight generation failed";
  return out;
}

/** Days → inclusive UTC range ending today. `days` is clamped to 1..31. */
export function rangeForDays(days: number, now: Date = new Date()): { start: string; end: string } {
  const n = Math.min(31, Math.max(1, Math.floor(days) || 7));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (n - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// ─── DynamoDB reads ───

export async function getSessionRowsForDate(date: string, send: Send = defaultSend): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  let pages = 0;
  do {
    const r = await send(new QueryCommand({
      TableName: SESSIONS_TABLE,
      IndexName: DATE_INDEX,
      KeyConditionExpression: "gsiDate = :d",
      ExpressionAttributeValues: { ":d": { S: date } },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of r.Items ?? []) {
      const row = toSessionRow(unmarshall(item));
      if (row) rows.push(row);
    }
    lastKey = r.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < MAX_PAGES);
  return rows;
}

export async function getSessionRows(dates: string[], send: Send = defaultSend): Promise<SessionRow[]> {
  const perDay = await Promise.all(dates.map((d) => getSessionRowsForDate(d, send)));
  return perDay.flat();
}

export async function getLatestInsight(send: Send = defaultSend): Promise<SessionInsight | null> {
  const r = await send(new QueryCommand({
    TableName: SESSIONS_TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": { S: INSIGHT_PK } },
    ScanIndexForward: false,
    Limit: 1,
  }));
  const item = r.Items?.[0];
  return item ? parseInsightRow(unmarshall(item)) : null;
}

export async function getInsightForDate(date: string, send: Send = defaultSend): Promise<SessionInsight | null> {
  const r = await send(new GetItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { PK: { S: INSIGHT_PK }, SK: { S: date } },
    ConsistentRead: true,
  }));
  return r.Item ? parseInsightRow(unmarshall(r.Item)) : null;
}

/**
 * The full §6 response for the last `days` days (UTC, including today). `insightDate`
 * returns that date's insight row instead of the latest (polling after a regenerate).
 */
export async function getSessionInsights(
  days: number,
  now: Date = new Date(),
  insightDate?: string
): Promise<SessionInsightsResponse> {
  const range = rangeForDays(days, now);
  const dates = dateRange(range.start, range.end);
  const [rows, metered, insight] = await Promise.all([
    getSessionRows(dates),
    getTotalUsage({ startDate: range.start, endDate: range.end }),
    insightDate ? getInsightForDate(insightDate) : getLatestInsight(),
  ]);
  const agg = aggregateSessions(rows, { topN: 10, dates });
  return {
    enabled: true,
    range,
    ...agg,
    metered: { estimatedCost: metered.totalCost },
    coverage: metered.totalCost > 0 ? agg.totals.estimatedCost / metered.totalCost : null,
    insight,
  };
}
