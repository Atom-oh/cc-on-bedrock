import { describe, it, expect } from "vitest";
import {
  dataVolumeMigrateScript,
  MIGRATE_MARKER,
  DATA_MOUNT,
} from "@/lib/data-volume-userdata";

const VOL = "vol-0abc123def456";
const SERIAL = "vol0abc123def456"; // NVMe serial = volume-id without the dash

describe("dataVolumeMigrateScript (ADR-032 Task 2: idempotent, fail-safe, volume-id keyed)", () => {
  const script = dataVolumeMigrateScript(VOL);

  it("resolves the block device by EBS volume-id (NVMe serial), not a device name", () => {
    // codex/agy CRITICAL: hardcoding /dev/sdf or /dev/nvme1n1 risks wiping the wrong disk.
    expect(script).toContain(`nvme-Amazon_Elastic_Block_Store_${SERIAL}`);
    expect(script).not.toContain("/dev/nvme1n1");
    // /dev/sdf must not be used as the mkfs/mount target.
    expect(script).not.toMatch(/mkfs\.\w+ -L CCDATA \/dev\/sdf/);
  });

  it("bounded-waits for the volume to attach before giving up (attach race)", () => {
    // a loop that polls for the device, then fail-safe exit if never present.
    expect(script).toMatch(/for .*seq|while/);
    expect(script.toLowerCase()).toContain("fail-safe");
  });

  it("fstab entry uses nofail + x-systemd.device-timeout (never brick boot)", () => {
    expect(script).toMatch(/LABEL=CCDATA\s+\/home\/coder\s+ext4\s+[^\n]*nofail/);
    expect(script).toContain("x-systemd.device-timeout");
  });

  it("guards mkfs behind a filesystem check (never reformat a volume that has data)", () => {
    const idxBlkid = script.indexOf("blkid");
    const idxMkfs = script.indexOf("mkfs");
    expect(idxBlkid).toBeGreaterThanOrEqual(0);
    expect(idxMkfs).toBeGreaterThan(idxBlkid); // a blkid check precedes mkfs
  });

  it("renames the original /home/coder ONLY AFTER the rsync copy is verified", () => {
    const idxRsync = script.indexOf("rsync");
    const idxRename = script.indexOf("/home/coder.old-root");
    expect(idxRsync).toBeGreaterThanOrEqual(0);
    expect(idxRename).toBeGreaterThan(idxRsync); // move-aside happens after the copy
  });

  it("is idempotent via the completion marker", () => {
    expect(script).toContain(MIGRATE_MARKER);
    expect(MIGRATE_MARKER).toBe("/home/coder/.cc-data-volume");
    expect(DATA_MOUNT).toBe("/home/coder");
  });

  it("does NOT call `systemctl restart` (would deadlock a Before=code-server oneshot)", () => {
    expect(script).not.toContain("systemctl restart");
  });
});
