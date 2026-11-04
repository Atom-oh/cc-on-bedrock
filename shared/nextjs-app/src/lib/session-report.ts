// Pure validation of a cc-bedrock-local session report (POST /api/local/sessions).
// One bucket = (tool, sessionId, UTC date) with cumulative totals; the tracker Lambda
// overwrites the row, so a re-sent bucket is idempotent. The tracker validates again.

export const SESSION_TOOLS = ["claude", "codex"] as const;
export type SessionTool = (typeof SESSION_TOOLS)[number];

export const MAX_BUCKETS = 100;
export const MAX_MODELS = 20;
/** Oldest accepted bucket date, in days before today (UTC). */
export const MAX_AGE_DAYS = 35;
/** A client clock may run ahead of UTC; accept dates up to this many days after today. */
export const FUTURE_TOLERANCE_DAYS = 1;

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ISO-8601 UTC timestamp, e.g. 2026-11-04T01:02:03Z or 2026-11-04T01:02:03.456Z / +00:00.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]00:00)$/;

const MODEL_FIELDS = [
  "requests",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;
type ModelField = (typeof MODEL_FIELDS)[number];
export type ModelUsage = Record<ModelField, number>;

export interface SessionBucket {
  tool: SessionTool;
  sessionId: string;
  date: string;
  firstAt: string;
  lastAt: string;
  turns: number;
  models: Record<string, ModelUsage>;
}

export type SessionReportResult =
  | { ok: true; buckets: SessionBucket[] }
  | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Sanity ceiling, same as the tracker's _SESSION_COUNT_MAX. */
export const COUNT_MAX = 10 ** 13;

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= COUNT_MAX;

function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** A real calendar date (rejects 2026-02-30) as epoch ms at UTC midnight, or null. */
function parseDate(s: string): number | null {
  if (!DATE_RE.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === s ? ms : null;
}

function validateBucket(raw: unknown, i: number, now: Date): SessionBucket | string {
  const at = `buckets[${i}]`;
  if (!isObject(raw)) return `${at} must be an object`;
  const { tool, sessionId, date, firstAt, lastAt, turns, models } = raw;
  if (typeof tool !== "string" || !(SESSION_TOOLS as readonly string[]).includes(tool)) {
    return `${at}.tool must be one of ${SESSION_TOOLS.join(", ")}`;
  }
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return `${at}.sessionId must be 1-128 chars of [A-Za-z0-9._:-]`;
  }
  const day = typeof date === "string" ? parseDate(date) : null;
  if (day === null) return `${at}.date must be YYYY-MM-DD`;
  const today = utcDay(now);
  const DAY = 86_400_000;
  if (day < today - MAX_AGE_DAYS * DAY) return `${at}.date is older than ${MAX_AGE_DAYS} days`;
  if (day > today + FUTURE_TOLERANCE_DAYS * DAY) return `${at}.date is in the future`;
  for (const [name, v] of [["firstAt", firstAt], ["lastAt", lastAt]] as const) {
    if (typeof v !== "string" || !ISO_RE.test(v) || Number.isNaN(Date.parse(v))) {
      return `${at}.${name} must be an ISO-8601 UTC timestamp`;
    }
  }
  if (!isCount(turns)) return `${at}.turns must be a non-negative integer`;
  if (!isObject(models)) return `${at}.models must be an object`;
  const keys = Object.keys(models);
  if (keys.length < 1 || keys.length > MAX_MODELS) {
    return `${at}.models must have 1-${MAX_MODELS} entries`;
  }
  const out: Record<string, ModelUsage> = {};
  for (const key of keys) {
    if (key.length < 1 || key.length > 128) return `${at}.models key must be 1-128 chars`;
    const m = models[key];
    if (!isObject(m)) return `${at}.models["${key.slice(0, 40)}"] must be an object`;
    const usage = {} as ModelUsage;
    for (const f of MODEL_FIELDS) {
      // A missing counter is 0; a present one must be a non-negative integer.
      const v = m[f] ?? 0;
      if (!isCount(v)) return `${at}.models["${key.slice(0, 40)}"].${f} must be a non-negative integer`;
      usage[f] = v;
    }
    out[key] = usage;
  }
  return {
    tool: tool as SessionTool,
    sessionId,
    date: date as string,
    firstAt: firstAt as string,
    lastAt: lastAt as string,
    turns,
    models: out,
  };
}

/**
 * Validate `{buckets: [...]}`. Returns normalized buckets (unknown fields dropped; a
 * bucket repeated in one request keeps its last occurrence) or the first error.
 */
export function validateSessionReport(body: unknown, now: Date = new Date()): SessionReportResult {
  if (!isObject(body)) return { ok: false, error: "Body must be a JSON object" };
  const { buckets } = body;
  if (!Array.isArray(buckets)) return { ok: false, error: "buckets must be an array" };
  if (buckets.length < 1 || buckets.length > MAX_BUCKETS) {
    return { ok: false, error: `buckets must have 1-${MAX_BUCKETS} entries` };
  }
  const byKey = new Map<string, SessionBucket>();
  for (let i = 0; i < buckets.length; i++) {
    const r = validateBucket(buckets[i], i, now);
    if (typeof r === "string") return { ok: false, error: r };
    const key = `${r.tool}#${r.sessionId}#${r.date}`;
    byKey.delete(key);
    byKey.set(key, r);
  }
  return { ok: true, buckets: Array.from(byKey.values()) };
}
