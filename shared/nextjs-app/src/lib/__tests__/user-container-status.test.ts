import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  instances: vi.fn(),
}));
vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/aws-clients", () => ({ getCognitoUser: vi.fn(), getLiveSecurityPolicy: vi.fn() }));
vi.mock("@/lib/ec2-clients", () => ({
  listInstances: mocks.instances, startInstance: vi.fn(), stopInstance: vi.fn(),
}));
import { GET } from "@/app/api/user/container/route";

describe("self-service environment lifecycle status", () => {
  beforeEach(() => {
    mocks.session.mockResolvedValue({ user: { email: "user@example.test", subdomain: "user" } });
    mocks.instances.mockResolvedValue([]);
  });

  it("keeps the user's stopping instance visible and does not select another user's instance", async () => {
    mocks.instances.mockResolvedValue([
      { instanceId: "i-other", subdomain: "other", status: "running" },
      { instanceId: "i-user", subdomain: "user", status: "stopping" },
    ]);
    const res = await GET(new NextRequest("https://example.test/api/user/container"));
    expect(await res.json()).toMatchObject({
      success: true, data: { taskId: "i-user", status: "STOPPING", desiredStatus: "STOPPED", healthStatus: "UNKNOWN" },
    });
  });

  it("shows no active environment only once the instance is stopped", async () => {
    mocks.instances.mockResolvedValue([{ instanceId: "i-user", subdomain: "user", status: "stopped" }]);
    const res = await GET(new NextRequest("https://example.test/api/user/container"));
    expect(await res.json()).toEqual({ success: true, data: null });
  });

  it("preserves hibernation so the user can resume", async () => {
    mocks.instances.mockResolvedValue([{ instanceId: "i-user", subdomain: "user", status: "hibernated" }]);
    const res = await GET(new NextRequest("https://example.test/api/user/container"));
    expect(await res.json()).toMatchObject({ data: { status: "HIBERNATED" } });
  });

  it("rejects unauthenticated status requests before reading infrastructure", async () => {
    mocks.instances.mockClear();
    mocks.session.mockResolvedValue(null);
    const res = await GET(new NextRequest("https://example.test/api/user/container"));
    expect(res.status).toBe(401);
    expect(mocks.instances).not.toHaveBeenCalled();
  });
});
