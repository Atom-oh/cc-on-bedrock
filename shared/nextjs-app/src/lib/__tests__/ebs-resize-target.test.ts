import { describe, it, expect } from "vitest";
import { resizeTargetVolumeId } from "@/lib/data-volume";

describe("resizeTargetVolumeId (ADR-032 rule 7: resize the DATA volume, never OS root)", () => {
  it("prefers the data volume id when known", () => {
    expect(resizeTargetVolumeId("vol-data", "vol-legacy-root")).toBe("vol-data");
  });

  it("falls back to the legacy volume id (pre-migration instance) — no regression", () => {
    expect(resizeTargetVolumeId(null, "vol-legacy-root")).toBe("vol-legacy-root");
    expect(resizeTargetVolumeId(undefined, "vol-legacy-root")).toBe("vol-legacy-root");
  });

  it("returns null when nothing resolves (resize is then a no-op, not a wrong-target)", () => {
    expect(resizeTargetVolumeId(null, null)).toBeNull();
    expect(resizeTargetVolumeId(undefined, undefined)).toBeNull();
  });
});
