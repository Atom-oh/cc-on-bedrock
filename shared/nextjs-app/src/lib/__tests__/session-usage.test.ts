import { describe, it, expect } from "vitest";
import {
  aggregateSessions,
  dateRange,
  parseInsightRow,
  rangeForDays,
  sessionInsightsEnabled,
  toSessionRow,
  type SessionRow,
} from "../session-usage";

const row = (o: Partial<SessionRow>): SessionRow => ({
  email: "a@x.com",
  department: "eng",
  tool: "claude",
  sessionId: "s1",
  date: "2026-11-01",
  turns: 0,
  requests: 0,
  estimatedCost: 0,
  ...o,
});

describe("aggregateSessions", () => {
  it("returns zeros without dividing by zero", () => {
    const r = aggregateSessions([]);
    expect(r.totals).toEqual({
      sessions: 0, turns: 0, requests: 0, estimatedCost: 0, costPerTurn: 0, costPerSession: 0, avgTurnsPerSession: 0,
    });
    expect(r.topUsers).toEqual([]);
    expect(r.daily).toEqual([]);
  });

  it("computes totals, ratios and counts a multi-day session once", () => {
    const rows = [
      row({ sessionId: "s1", date: "2026-11-01", turns: 4, requests: 10, estimatedCost: 2 }),
      row({ sessionId: "s1", date: "2026-11-02", turns: 2, requests: 5, estimatedCost: 1 }),
      row({ sessionId: "s2", date: "2026-11-02", tool: "codex", turns: 4, requests: 3, estimatedCost: 3 }),
    ];
    const r = aggregateSessions(rows);
    expect(r.totals.sessions).toBe(2);
    expect(r.totals.turns).toBe(10);
    expect(r.totals.requests).toBe(18);
    expect(r.totals.estimatedCost).toBe(6);
    expect(r.totals.costPerTurn).toBeCloseTo(0.6);
    expect(r.totals.costPerSession).toBe(3);
    expect(r.totals.avgTurnsPerSession).toBe(5);
    const u = r.topUsers[0];
    expect(u.tools.claude).toEqual({ sessions: 1, turns: 6, estimatedCost: 3 });
    expect(u.tools.codex).toEqual({ sessions: 1, turns: 4, estimatedCost: 3 });
  });

  it("guards costPerTurn when a session has no turns", () => {
    const r = aggregateSessions([row({ turns: 0, estimatedCost: 5 })]);
    expect(r.totals.costPerTurn).toBe(0);
    expect(r.topUsers[0].costPerTurn).toBe(0);
    expect(r.topUsers[0].costPerSession).toBe(5);
  });

  it("does not merge the same sessionId of different users", () => {
    const r = aggregateSessions([row({ email: "a@x.com" }), row({ email: "b@x.com" })]);
    expect(r.totals.sessions).toBe(2);
  });

  it("ranks top users by cost and honours topN", () => {
    const rows = [
      row({ email: "a@x.com", estimatedCost: 1 }),
      row({ email: "b@x.com", estimatedCost: 5 }),
      row({ email: "c@x.com", estimatedCost: 3 }),
    ];
    expect(aggregateSessions(rows, { topN: 2 }).topUsers.map((u) => u.email)).toEqual(["b@x.com", "c@x.com"]);
  });

  it("builds a zero-filled, sorted daily series", () => {
    const r = aggregateSessions(
      [
        row({ date: "2026-11-03", sessionId: "x", turns: 2, estimatedCost: 1 }),
        row({ date: "2026-11-01", sessionId: "y", turns: 1, estimatedCost: 0.5 }),
      ],
      { dates: dateRange("2026-11-01", "2026-11-03") }
    );
    expect(r.daily).toEqual([
      { date: "2026-11-01", sessions: 1, turns: 1, estimatedCost: 0.5 },
      { date: "2026-11-02", sessions: 0, turns: 0, estimatedCost: 0 },
      { date: "2026-11-03", sessions: 1, turns: 2, estimatedCost: 1 },
    ]);
  });
});

describe("toSessionRow", () => {
  it("normalizes a DynamoDB row", () => {
    expect(toSessionRow({
      PK: "USER#A@x.com", email: "A@x.com", department: "eng", tool: "codex", sessionId: "s", date: "2026-11-01",
      turns: 2, requests: 3, estimatedCost: "0.5",
    })).toEqual({ email: "a@x.com", department: "eng", tool: "codex", sessionId: "s", date: "2026-11-01", turns: 2, requests: 3, estimatedCost: 0.5 });
  });
  it("rejects rows that are not session buckets", () => {
    expect(toSessionRow({ PK: "INSIGHT#daily", SK: "2026-11-01" })).toBeNull();
    expect(toSessionRow({ email: "a@x.com", tool: "kiro", sessionId: "s", date: "d" })).toBeNull();
  });
  it("treats negative or non-numeric counters as 0", () => {
    const r = toSessionRow({ email: "a@x.com", tool: "claude", sessionId: "s", date: "d", turns: -3, estimatedCost: "x" });
    expect(r?.turns).toBe(0);
    expect(r?.estimatedCost).toBe(0);
  });
});

describe("parseInsightRow", () => {
  const base = {
    PK: "INSIGHT#daily",
    SK: "2026-11-03",
    date: "2026-11-03",
    generatedAt: "2026-11-04T00:00:05Z",
    model: "global.anthropic.claude-haiku-5-5",
    status: "ok",
    labels: JSON.stringify({ U1: "alice@x.com", U2: "bob@x.com" }),
  };

  it("maps labels back to emails in findings and text", () => {
    const r = parseInsightRow({
      ...base,
      insight: JSON.stringify({
        summary: "U1 drives most cost; U2 and U10 are fine.",
        findings: [
          { user: "U1", severity: "action", title: "High $/turn for U1", detail: "d", suggestion: "s" },
          { user: "U9", severity: "bogus", title: "t", detail: "", suggestion: "" },
        ],
        fleet: ["U2 cache reuse is low"],
      }),
    });
    expect(r?.status).toBe("ok");
    expect(r?.summary).toBe("alice@x.com drives most cost; bob@x.com and U10 are fine.");
    expect(r?.findings[0]).toEqual({
      user: "alice@x.com", label: "U1", severity: "action", title: "High $/turn for alice@x.com", detail: "d", suggestion: "s",
    });
    expect(r?.findings[1].user).toBe("U9");
    expect(r?.findings[1].severity).toBe("info");
    expect(r?.fleet).toEqual(["bob@x.com cache reuse is low"]);
  });

  it("survives malformed JSON fields", () => {
    const r = parseInsightRow({ ...base, status: "error", error: "parse failed", insight: "{not json", labels: "[]" });
    expect(r).toMatchObject({ status: "error", error: "parse failed", summary: "", findings: [], fleet: [] });
  });

  it("caps findings at 8 and ignores non-object entries", () => {
    const findings = [null, "x", ...Array.from({ length: 10 }, () => ({ user: "U1", title: "t" }))];
    const r = parseInsightRow({ ...base, insight: JSON.stringify({ findings, fleet: [1, "ok"] }) });
    expect(r?.findings).toHaveLength(8);
    expect(r?.fleet).toEqual(["ok"]);
  });

  it("returns null for no row", () => {
    expect(parseInsightRow(null)).toBeNull();
  });
});

describe("rangeForDays / dateRange", () => {
  const now = new Date("2026-11-04T23:59:00Z");
  it("is inclusive of today", () => {
    expect(rangeForDays(7, now)).toEqual({ start: "2026-10-29", end: "2026-11-04" });
    expect(rangeForDays(1, now)).toEqual({ start: "2026-11-04", end: "2026-11-04" });
  });
  it("clamps to 1..31", () => {
    expect(rangeForDays(100, now).start).toBe("2026-10-05");
    expect(rangeForDays(0, now).start).toBe("2026-10-29");
  });
  it("lists dates across a month boundary", () => {
    expect(dateRange("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});

describe("sessionInsightsEnabled", () => {
  it("unset uses the default table (enabled); empty string = feature off", () => {
    expect(sessionInsightsEnabled({})).toBe(true);
    expect(sessionInsightsEnabled({ SESSIONS_TABLE: "t" })).toBe(true);
    expect(sessionInsightsEnabled({ SESSIONS_TABLE: "" })).toBe(false);
    expect(sessionInsightsEnabled({ SESSIONS_TABLE: "  " })).toBe(false);
  });
});
