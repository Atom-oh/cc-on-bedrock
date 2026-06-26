import { describe, it, expect } from "vitest";
import { deriveDevenvHealth } from "@/lib/devenv-health";

describe("deriveDevenvHealth", () => {
  it("returns HEALTHY when the instance is running and has a private IP", () => {
    expect(deriveDevenvHealth("running", "10.0.23.66")).toBe("HEALTHY");
  });

  it("returns UNKNOWN when running but the private IP is missing (ENI not attached yet)", () => {
    expect(deriveDevenvHealth("running", undefined)).toBe("UNKNOWN");
    expect(deriveDevenvHealth("running", "")).toBe("UNKNOWN");
    expect(deriveDevenvHealth("running", "   ")).toBe("UNKNOWN");
  });

  it("matches status case-insensitively and tolerates surrounding whitespace", () => {
    expect(deriveDevenvHealth("RUNNING", "10.0.23.66")).toBe("HEALTHY");
    expect(deriveDevenvHealth(" Running ", "10.0.23.66")).toBe("HEALTHY");
    expect(deriveDevenvHealth("running", " 10.0.23.66 ")).toBe("HEALTHY");
  });

  it("returns UNKNOWN for non-running states regardless of IP", () => {
    expect(deriveDevenvHealth("pending", "10.0.23.66")).toBe("UNKNOWN");
    expect(deriveDevenvHealth("stopped", "10.0.23.66")).toBe("UNKNOWN");
    expect(deriveDevenvHealth("hibernated", "10.0.23.66")).toBe("UNKNOWN");
  });

  it("returns UNKNOWN when status is undefined", () => {
    expect(deriveDevenvHealth(undefined, "10.0.23.66")).toBe("UNKNOWN");
  });
});
