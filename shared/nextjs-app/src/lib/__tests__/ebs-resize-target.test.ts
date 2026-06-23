import { describe, it, expect } from "vitest";
import { resizeTargetVolumeId } from "@/lib/data-volume";

describe("resizeTargetVolumeId (ADR-032 rule 7: resize the DATA volume, NEVER OS root)", () => {
  it("returns the data volume id when known", () => {
    expect(resizeTargetVolumeId("vol-data")).toBe("vol-data");
  });

  it("returns null for a pre-migration instance — resize is DEFERRED, never falls back to root", () => {
    // P4 fix: a legacy root volumeId must NOT become a resize target (would grow the OS disk).
    expect(resizeTargetVolumeId(null)).toBeNull();
    expect(resizeTargetVolumeId(undefined)).toBeNull();
  });
});
