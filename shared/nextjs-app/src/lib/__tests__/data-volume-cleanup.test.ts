import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the EC2 SDK so deleteDataVolume's detach→wait→delete sequence is observable without AWS.
// vi.hoisted: vi.mock is hoisted above imports, so the spy must be hoisted too (TDZ otherwise).
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@aws-sdk/client-ec2", () => {
  const mk = (name: string) =>
    function (this: { __type: string; input: unknown }, input: unknown) {
      this.__type = name;
      this.input = input;
    };
  return {
    EC2Client: function (this: { send: typeof sendMock }) {
      this.send = sendMock;
    },
    DescribeVolumesCommand: mk("DescribeVolumes"),
    DetachVolumeCommand: mk("DetachVolume"),
    DeleteVolumeCommand: mk("DeleteVolume"),
    CreateVolumeCommand: mk("CreateVolume"),
    AttachVolumeCommand: mk("AttachVolume"),
    CreateTagsCommand: mk("CreateTags"),
    DescribeSubnetsCommand: mk("DescribeSubnets"),
  };
});

import { deleteDataVolume, volumeIsAvailable } from "@/lib/data-volume";

const typeOf = (cmd: unknown) => (cmd as { __type?: string })?.__type ?? "";

beforeEach(() => sendMock.mockReset());

describe("volumeIsAvailable", () => {
  it("only `available` is actionable", () => {
    expect(volumeIsAvailable("available")).toBe(true);
    expect(volumeIsAvailable("in-use")).toBe(false);
    expect(volumeIsAvailable("deleting")).toBe(false);
    expect(volumeIsAvailable(undefined)).toBe(false);
  });
});

describe("deleteDataVolume (ADR-032 rule 9: detach → wait available → delete)", () => {
  it("detaches, waits for available, then deletes — in that order", async () => {
    sendMock.mockImplementation(async (cmd) => {
      if (typeOf(cmd) === "DescribeVolumes") return { Volumes: [{ State: "available" }] };
      return {};
    });
    const ok = await deleteDataVolume("vol-1", "i-123", { attempts: 3, delayMs: 0 });
    expect(ok).toBe(true);
    const order = sendMock.mock.calls.map((c) => typeOf(c[0]));
    expect(order).toContain("DetachVolume");
    expect(order).toContain("DeleteVolume");
    expect(order.indexOf("DetachVolume")).toBeLessThan(order.indexOf("DescribeVolumes"));
    expect(order.indexOf("DescribeVolumes")).toBeLessThan(order.indexOf("DeleteVolume"));
  });

  it("NEVER deletes a volume that never reaches available (still attached → no force-delete)", async () => {
    sendMock.mockImplementation(async (cmd) => {
      if (typeOf(cmd) === "DescribeVolumes") return { Volumes: [{ State: "in-use" }] };
      return {};
    });
    const ok = await deleteDataVolume("vol-2", "i-456", { attempts: 2, delayMs: 0 });
    expect(ok).toBe(false);
    const order = sendMock.mock.calls.map((c) => typeOf(c[0]));
    expect(order).not.toContain("DeleteVolume");
  });
});
