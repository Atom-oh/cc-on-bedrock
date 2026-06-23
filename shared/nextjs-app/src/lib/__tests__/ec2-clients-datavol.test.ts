import { describe, it, expect } from "vitest";
import {
  planDataVolumeLaunch,
  dataVolumeIdFromInstance,
  DATA_DEVICE,
} from "@/lib/data-volume";

describe("planDataVolumeLaunch (ADR-032 Task 3: born-attached vs AZ-pinned reattach)", () => {
  it("new user → born-attached with a persistent BDM, no AZ pin", () => {
    const plan = planDataVolumeLaunch(null, 60);
    expect(plan.mode).toBe("born-attached");
    expect(plan.blockDeviceMappings).toHaveLength(1);
    expect(plan.blockDeviceMappings[0].Ebs?.DeleteOnTermination).toBe(false);
    expect(plan.blockDeviceMappings[0].Ebs?.VolumeSize).toBe(60);
    expect(plan.pinAz).toBeNull();
    expect(plan.expectedVolumeId).toBeNull();
  });

  it("returning user → reattach pinned to the volume's AZ, no born BDM", () => {
    const plan = planDataVolumeLaunch({ volumeId: "vol-9", az: "ap-northeast-2c", state: "available" });
    expect(plan.mode).toBe("reattach");
    expect(plan.blockDeviceMappings).toHaveLength(0); // never create a 2nd volume
    expect(plan.pinAz).toBe("ap-northeast-2c"); // CRITICAL: pin to avoid ZoneMismatch
    expect(plan.expectedVolumeId).toBe("vol-9"); // boot unit waits for THIS volume
  });
});

describe("dataVolumeIdFromInstance (resolve born-attached volume id post-launch for tagging)", () => {
  it("picks the volume id mapped at /dev/sdf", () => {
    const id = dataVolumeIdFromInstance([
      { DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-root" } },
      { DeviceName: DATA_DEVICE, Ebs: { VolumeId: "vol-data" } },
    ]);
    expect(id).toBe("vol-data");
  });

  it("returns null when no data device is present (root-only legacy instance)", () => {
    expect(dataVolumeIdFromInstance([{ DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-root" } }])).toBeNull();
    expect(dataVolumeIdFromInstance(undefined)).toBeNull();
  });
});
