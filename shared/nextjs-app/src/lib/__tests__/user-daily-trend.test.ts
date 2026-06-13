import { describe, it, expect } from "vitest";
import { buildUserDailyTrend } from "../usage-client";
import type { UsageRecord } from "../usage-client";

function rec(userId: string, date: string, cost: number, tokens: number): UsageRecord {
  return {
    userId, department: "eng", date, model: "claude-x",
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: tokens, requests: 1, estimatedCost: cost, latencySumMs: 0,
  };
}

describe("buildUserDailyTrend", () => {
  it("pivots per (user, date) summing cost and tokens (namespaced keys)", () => {
    const recs = [
      rec("alice", "2026-06-11", 1.0, 100),
      rec("alice", "2026-06-11", 0.5, 50),  // same cell → summed
      rec("bob", "2026-06-12", 2.0, 200),
    ];
    const t = buildUserDailyTrend(recs, { startDate: "2026-06-11", endDate: "2026-06-12", topN: 8 });
    const d11 = t.cost.find((p) => p.date === "2026-06-11")!;
    expect(d11.u_alice).toBeCloseTo(1.5);
    const tok12 = t.tokens.find((p) => p.date === "2026-06-12")!;
    expect(tok12.u_bob).toBe(200);
    // series key is namespaced, name is the raw subdomain
    expect(t.series.find((s) => s.name === "alice")!.key).toBe("u_alice");
  });

  it("namespaces keys so a subdomain 'date' or 'others' cannot collide", () => {
    const recs = [rec("date", "2026-06-11", 1, 10), rec("others", "2026-06-11", 2, 20)];
    const t = buildUserDailyTrend(recs, { startDate: "2026-06-11", endDate: "2026-06-11", topN: 8 });
    const p = t.cost[0];
    expect(p.date).toBe("2026-06-11");   // x-axis intact, not overwritten by user "date"
    expect(p.u_date).toBe(1);            // user "date" lives under namespaced key
    expect(p.u_others).toBe(2);          // user "others" does not collide with aggregate
  });

  it("generates the full calendar axis with zero-fill (no gaps)", () => {
    const recs = [rec("alice", "2026-06-11", 1, 10), rec("alice", "2026-06-13", 1, 10)];
    const t = buildUserDailyTrend(recs, { startDate: "2026-06-11", endDate: "2026-06-13", topN: 8 });
    expect(t.cost.map((p) => p.date)).toEqual(["2026-06-11", "2026-06-12", "2026-06-13"]);
    expect(t.cost.find((p) => p.date === "2026-06-12")!.u_alice).toBe(0);  // gap day → 0
  });

  it("keeps Top-N by cost and folds the rest into one 'others' series", () => {
    const recs = [
      rec("u1", "2026-06-11", 10, 1),
      rec("u2", "2026-06-11", 9, 1),
      rec("u3", "2026-06-11", 8, 1),
      rec("u4", "2026-06-11", 7, 1),
    ];
    const t = buildUserDailyTrend(recs, { startDate: "2026-06-11", endDate: "2026-06-11", topN: 2 });
    const keys = t.series.map((s) => s.key);
    expect(keys).toEqual(["u_u1", "u_u2", "__others__"]);
    expect(t.othersCount).toBe(2);
    expect(t.cost[0].__others__).toBeCloseTo(15); // u3 + u4
  });

  it("emits no 'others' when users <= topN", () => {
    const recs = [rec("u1", "2026-06-11", 1, 1)];
    const t = buildUserDailyTrend(recs, { startDate: "2026-06-11", endDate: "2026-06-11", topN: 8 });
    expect(t.series.map((s) => s.key)).toEqual(["u_u1"]);
    expect(t.othersCount).toBe(0);
  });
});
