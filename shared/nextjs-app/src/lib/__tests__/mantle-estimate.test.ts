import { describe, expect, it } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import { MANTLE_ESTIMATE_CAVEAT, summarizeMantle, toMantleRow } from "../mantle-estimate";

const row = (email: string, date: string, model: string, cost: number, updatedAt = "2026-10-28T03:00:00") =>
  ({ email, date, model, inputTokens: 1000, outputTokens: 10, estimatedCost: cost, updatedAt });

describe("mantle estimate (ADR-014 §9 stage 1)", () => {
  it("parses a MANTLE# usage row", () => {
    const r = toMantleRow(marshall({
      PK: "MANTLE#demo@atomai.click", SK: "2026-10-26#gpt-6.1-sol",
      inputTokens: 65665, outputTokens: 334, estimatedCost: 0.13467, updatedAt: "2026-10-26T23:59:00",
    }));
    expect(r).toEqual({
      email: "demo@atomai.click", date: "2026-10-26", model: "gpt-6.1-sol",
      inputTokens: 65665, outputTokens: 334, estimatedCost: 0.13467, updatedAt: "2026-10-26T23:59:00",
    });
  });

  it("sums the period per user, costliest first, and ignores other months", () => {
    const out = summarizeMantle([
      row("a@x.com", "2026-10-01", "gpt-6.1-sol", 1),
      row("a@x.com", "2026-10-02", "gpt-6-luna", 2, "2026-10-02T00:00:00"),
      row("b@x.com", "2026-10-03", "gpt-6.1-sol", 5),
      row("a@x.com", "2026-09-30", "gpt-6.1-sol", 100),
    ], "2026-10");
    expect(out.map((u) => [u.email, u.estimatedCost])).toEqual([["b@x.com", 5], ["a@x.com", 3]]);
    expect(out[1].models).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(out[1].inputTokens).toBe(2000);
  });

  it("caveat states the estimate can be wrong and is not enforced", () => {
    expect(MANTLE_ESTIMATE_CAVEAT).toMatch(/may differ from the AWS bill/);
    expect(MANTLE_ESTIMATE_CAVEAT).toMatch(/web-search query charges excluded/);
    expect(MANTLE_ESTIMATE_CAVEAT).toMatch(/Not counted toward any budget/);
  });
});
