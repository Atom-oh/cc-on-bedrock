import { describe, it, expect } from "vitest";
import { validateSessionReport, MAX_BUCKETS } from "../session-report";

const NOW = new Date("2026-11-04T12:00:00Z");
const bucket = (over: Record<string, unknown> = {}) => ({
  tool: "claude",
  sessionId: "0b6c1e2a-1234-4abc-9def-000000000001",
  date: "2026-11-04",
  firstAt: "2026-11-04T01:02:03.456Z",
  lastAt: "2026-11-04T02:00:00Z",
  turns: 3,
  models: {
    "claude-opus-4-8": { requests: 5, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
  },
  ...over,
});
const run = (buckets: unknown) => validateSessionReport({ buckets }, NOW);

describe("validateSessionReport", () => {
  it("accepts a valid bucket and drops unknown fields", () => {
    const r = run([{ ...bucket(), extra: "x" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.buckets).toHaveLength(1);
      expect(r.buckets[0]).not.toHaveProperty("extra");
      expect(r.buckets[0].models["claude-opus-4-8"].cacheWriteTokens).toBe(40);
    }
  });

  it("defaults missing model counters to 0", () => {
    const r = run([bucket({ models: { "gpt-6": { requests: 1 } } })]);
    expect(r.ok && r.buckets[0].models["gpt-6"]).toEqual({
      requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it("keeps the last copy of a repeated bucket", () => {
    const r = run([bucket({ turns: 1 }), bucket({ turns: 7 })]);
    expect(r.ok && r.buckets.map((b) => b.turns)).toEqual([7]);
  });

  it.each([
    ["non-object body", null],
    ["missing buckets", {}],
    ["buckets not array", { buckets: {} }],
    ["empty buckets", { buckets: [] }],
    ["too many buckets", { buckets: Array.from({ length: MAX_BUCKETS + 1 }, (_, i) => bucket({ sessionId: `s${i}` })) }],
  ])("rejects %s", (_n, body) => {
    expect(validateSessionReport(body, NOW).ok).toBe(false);
  });

  it("accepts exactly MAX_BUCKETS", () => {
    expect(run(Array.from({ length: MAX_BUCKETS }, (_, i) => bucket({ sessionId: `s${i}` }))).ok).toBe(true);
  });

  it.each([
    ["tool", { tool: "kiro" }],
    ["sessionId empty", { sessionId: "" }],
    ["sessionId chars", { sessionId: "a/b" }],
    ["sessionId length", { sessionId: "a".repeat(129) }],
    ["date format", { date: "2026-11-4" }],
    ["date calendar", { date: "2026-02-30" }],
    ["date too old", { date: "2026-09-29" }],
    ["date in future", { date: "2026-11-06" }],
    ["firstAt", { firstAt: "yesterday" }],
    ["lastAt non-UTC", { lastAt: "2026-11-04T02:00:00+09:00" }],
    ["turns negative", { turns: -1 }],
    ["turns fraction", { turns: 1.5 }],
    ["turns string", { turns: "3" }],
    ["models empty", { models: {} }],
    ["models array", { models: [] }],
    ["models too many", { models: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m${i}`, { requests: 1 }])) }],
    ["model key too long", { models: { ["m".repeat(129)]: { requests: 1 } } }],
    ["model counter negative", { models: { m: { requests: -1 } } }],
    ["model counter huge", { models: { m: { inputTokens: 10 ** 14 } } }],
    ["model value not object", { models: { m: 5 } }],
  ])("rejects bad %s", (_n, over) => {
    const r = run([bucket(over)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/buckets\[0\]/);
  });

  it("accepts the date window edges (35 days back, +1 day)", () => {
    expect(run([bucket({ date: "2026-09-30" })]).ok).toBe(true);
    expect(run([bucket({ date: "2026-11-05" })]).ok).toBe(true);
  });
});
