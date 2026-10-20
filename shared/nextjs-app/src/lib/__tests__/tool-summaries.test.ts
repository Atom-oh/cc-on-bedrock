import { describe, it, expect } from "vitest";
import { buildToolSummaries, toolForModel } from "../usage-client";
import type { UsageRecord } from "../usage-client";

function rec(userId: string, model: string, cost: number, tool = toolForModel(model)): UsageRecord {
  return {
    userId, department: "eng", date: "2026-10-18", model, tool,
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0,
    totalTokens: 115, requests: 1, estimatedCost: cost, latencySumMs: 0,
  };
}

describe("toolForModel (ADR-014)", () => {
  it("maps model vendor to CLI", () => {
    expect(toolForModel("claude-opus-4-8")).toBe("claude-code");
    expect(toolForModel("gpt-6.1-sol")).toBe("codex");
    expect(toolForModel("titan-embed-text-v2")).toBe("other");
  });
});

describe("buildToolSummaries", () => {
  it("splits cost/tokens/users per tool, highest cost first", () => {
    const out = buildToolSummaries([
      rec("a@x.com", "claude-opus-4-8", 1.5),
      rec("b@x.com", "claude-sonnet-5", 0.5),
      rec("a@x.com", "gpt-6.1-sol", 3),
      rec("a@x.com", "gpt-6-luna", 0.25),
    ]);
    expect(out.map((t) => t.tool)).toEqual(["codex", "claude-code"]);
    const codex = out[0];
    expect(codex.totalCost).toBeCloseTo(3.25);
    expect(codex.userCount).toBe(1);
    expect(codex.requests).toBe(2);
    expect(codex.models).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
    expect(out[1].userCount).toBe(2);
    expect(out[1].inputTokens).toBe(200);
  });

  it("returns [] for no usage", () => {
    expect(buildToolSummaries([])).toEqual([]);
  });
});
