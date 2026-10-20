import { describe, expect, it } from "vitest";
import { readContainerStatus } from "../portal-status";

describe("user portal status responses", () => {
  it("accepts only an explicit successful empty result as a stopped environment", async () => {
    await expect(readContainerStatus(Response.json({ success: true, data: null }))).resolves.toBeNull();
  });

  it.each([
    [500, { error: "Unavailable" }],
    [401, { error: "Authentication required" }],
    [200, { success: false }],
    [200, { success: "false", data: null }],
    [200, { success: true }],
    [200, { success: true, data: {} }],
  ])("rejects unavailable or incomplete state (%s)", async (status, body) => {
    await expect(readContainerStatus(Response.json(body, { status }))).rejects.toThrow();
  });

  it("does not interpret an HTML login response as an empty environment", async () => {
    await expect(readContainerStatus(new Response("<html>Sign in</html>"))).rejects.toThrow();
  });

  it("preserves a stopping instance until a later successful status confirms completion", async () => {
    const instance = { taskId: "i-user", status: "STOPPING", desiredStatus: "STOPPED" };
    await expect(readContainerStatus(Response.json({ success: true, data: instance }))).resolves.toEqual(instance);
  });
});
