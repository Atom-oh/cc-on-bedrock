import { describe, it, expect } from "vitest";
import {
  dataVolumeTags,
  dataVolumeBlockDeviceMapping,
  pickDataVolume,
  pickSubnetForAz,
  DATA_LABEL,
  DATA_DEVICE,
} from "@/lib/data-volume";

describe("dataVolumeBlockDeviceMapping (ADR-032: born-attached, persistent)", () => {
  it("is /dev/sdf, gp3, DeleteOnTermination=false, Encrypted=true", () => {
    const bdm = dataVolumeBlockDeviceMapping(50);
    expect(bdm.DeviceName).toBe(DATA_DEVICE);
    expect(bdm.Ebs?.VolumeType).toBe("gp3");
    expect(bdm.Ebs?.VolumeSize).toBe(50);
    // CRITICAL: data must survive instance termination (ADR-032 rule 6).
    expect(bdm.Ebs?.DeleteOnTermination).toBe(false);
    expect(bdm.Ebs?.Encrypted).toBe(true);
  });
});

describe("dataVolumeTags (ADR-032: post-launch CreateTags identity)", () => {
  it("carries cc:role=data, cc:subdomain, cc:project for IAM ResourceTag scoping", () => {
    const tags = dataVolumeTags("alice", "alice@example.com", "eng");
    const kv = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
    expect(kv["cc:role"]).toBe("data");
    expect(kv["cc:subdomain"]).toBe("alice");
    expect(kv["cc:project"]).toBe("cc-on-bedrock");
    expect(kv["managed_by"]).toBe("cc-on-bedrock");
  });
});

describe("pickDataVolume (ADR-032 rule 1: DynamoDB authoritative, tag lookup fail-closed)", () => {
  it("returns null when no volume matches", () => {
    expect(pickDataVolume([])).toBeNull();
    expect(pickDataVolume(undefined)).toBeNull();
  });

  it("returns {volumeId, az, state} for a single match", () => {
    const got = pickDataVolume([
      { VolumeId: "vol-1", AvailabilityZone: "ap-northeast-2a", State: "available" },
    ]);
    expect(got).toEqual({ volumeId: "vol-1", az: "ap-northeast-2a", state: "available" });
  });

  it("FAIL-CLOSED: throws when more than one volume matches (no guessing → no wrong-user data)", () => {
    expect(() =>
      pickDataVolume([
        { VolumeId: "vol-1", AvailabilityZone: "ap-northeast-2a", State: "available" },
        { VolumeId: "vol-2", AvailabilityZone: "ap-northeast-2c", State: "available" },
      ]),
    ).toThrow(/fail-closed/i);
  });

  it("ignores deleting/deleted volumes when counting matches", () => {
    const got = pickDataVolume([
      { VolumeId: "vol-old", AvailabilityZone: "ap-northeast-2a", State: "deleting" },
      { VolumeId: "vol-1", AvailabilityZone: "ap-northeast-2c", State: "available" },
    ]);
    expect(got?.volumeId).toBe("vol-1");
  });
});

describe("pickSubnetForAz (ADR-032 rule 2: AZ pinning, fail-closed on mismatch)", () => {
  const subnets = [
    { SubnetId: "subnet-a", AvailabilityZone: "ap-northeast-2a" },
    { SubnetId: "subnet-c", AvailabilityZone: "ap-northeast-2c" },
  ];

  it("returns the subnet in the volume's AZ", () => {
    expect(pickSubnetForAz(subnets, "ap-northeast-2c")).toBe("subnet-c");
  });

  it("FAIL-CLOSED: throws when no subnet exists in the volume's AZ (would ZoneMismatch-brick)", () => {
    expect(() => pickSubnetForAz(subnets, "ap-northeast-2b")).toThrow(/AZ/);
  });
});

describe("DATA_LABEL", () => {
  it("is CCDATA (fstab mounts by LABEL, never device name)", () => {
    expect(DATA_LABEL).toBe("CCDATA");
  });
});
