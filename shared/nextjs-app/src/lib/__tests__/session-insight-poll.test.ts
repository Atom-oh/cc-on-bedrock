import { describe, it, expect } from "vitest";
import { POLL_TIMEOUT_MS, insightRefreshed, shouldKeepPolling } from "../session-insight-poll";

describe("insightRefreshed", () => {
  const req = "2026-11-04T03:00:00.000Z";
  it("is true only for the requested date generated after the request", () => {
    expect(insightRefreshed({ date: "2026-11-03", generatedAt: "2026-11-04T03:00:20Z" }, "2026-11-03", req)).toBe(true);
    expect(insightRefreshed({ date: "2026-11-03", generatedAt: "2026-11-04T00:00:05Z" }, "2026-11-03", req)).toBe(false);
    expect(insightRefreshed({ date: "2026-11-03", generatedAt: req }, "2026-11-03", req)).toBe(false);
    expect(insightRefreshed({ date: "2026-11-02", generatedAt: "2026-11-04T03:00:20Z" }, "2026-11-03", req)).toBe(false);
  });
  it("is false for a missing row or unparsable times", () => {
    expect(insightRefreshed(null, "2026-11-03", req)).toBe(false);
    expect(insightRefreshed({ date: "2026-11-03", generatedAt: "" }, "2026-11-03", req)).toBe(false);
    expect(insightRefreshed({ date: "2026-11-03", generatedAt: "2026-11-04T03:00:20Z" }, "2026-11-03", "x")).toBe(false);
  });
});

describe("shouldKeepPolling", () => {
  it("stops at the 3-minute deadline", () => {
    expect(POLL_TIMEOUT_MS).toBe(180_000);
    expect(shouldKeepPolling(0, 179_999)).toBe(true);
    expect(shouldKeepPolling(0, 180_000)).toBe(false);
  });
});
