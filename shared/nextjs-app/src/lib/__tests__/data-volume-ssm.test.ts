import { describe, it, expect } from "vitest";
import { azFromInstanceDescribe, buildLegacyMigrateCommand } from "@/lib/data-volume-ssm";

describe("azFromInstanceDescribe (ADR-032 Task 6: data volume must be created in the instance AZ)", () => {
  it("extracts the running instance's AZ", () => {
    const az = azFromInstanceDescribe([
      { Instances: [{ Placement: { AvailabilityZone: "ap-northeast-2c" } }] },
    ]);
    expect(az).toBe("ap-northeast-2c");
  });

  it("returns null when no placement is present", () => {
    expect(azFromInstanceDescribe([])).toBeNull();
    expect(azFromInstanceDescribe(undefined)).toBeNull();
    expect(azFromInstanceDescribe([{ Instances: [{}] }])).toBeNull();
  });
});

describe("buildLegacyMigrateCommand (SSM RunCommand for a legacy instance)", () => {
  const cmds = buildLegacyMigrateCommand("vol-0abc123def456");

  it("writes the expected-volume hint before running the migrate routine", () => {
    expect(cmds[0]).toContain("/etc/cc-data-expected-volume");
    expect(cmds[0]).toContain("vol-0abc123def456");
  });

  it("includes the idempotent migrate routine keyed to that exact volume (NVMe serial)", () => {
    const body = cmds.join("\n");
    expect(body).toContain("nvme-Amazon_Elastic_Block_Store_vol0abc123def456");
    expect(body).toContain("/home/coder/.cc-data-volume"); // idempotency marker
    expect(body.toLowerCase()).toContain("fail-safe");
  });
});
