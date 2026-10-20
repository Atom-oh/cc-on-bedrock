import { describe, expect, it, vi } from "vitest";
import { readProvisioningStream } from "../provisioning-stream";
import type { ProvisioningEvent } from "../types";

const ready = { step: 7, name: "health_check", status: "completed", url: "https://example.test" };
const storage = { step: 2, name: "storage_prepare", status: "completed", message: "스토리지 준비 완료" };
const frame = (event: object) => `data: ${JSON.stringify(event)}\r\n\r\n`;

function response(chunks: Uint8Array[]) {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk));
      controller.close();
    },
  }));
}

describe("provisioning progress stream", () => {
  it("handles byte-by-byte UTF-8 chunks and all reported storage events", async () => {
    const bytes = new TextEncoder().encode(frame(storage) + frame(ready));
    const events: ProvisioningEvent[] = [];
    await expect(readProvisioningStream(response(Array.from(bytes, byte => new Uint8Array([byte]))),
      event => events.push(event))).resolves.toBe(ready.url);
    expect(events).toEqual([storage, ready]);
  });

  it("accepts a terminal event without a final newline", async () => {
    const payload = new TextEncoder().encode(`data: ${JSON.stringify(ready)}`);
    await expect(readProvisioningStream(response([payload]), () => {})).resolves.toBe(ready.url);
  });

  it.each(["", frame(storage), "data: malformed\n", 'data: {"step":7}\n'])(
    "rejects an incomplete or malformed stream instead of hanging (%s)", async text => {
      await expect(readProvisioningStream(new Response(text), () => {})).rejects.toMatchObject({ reason: "connection" });
    },
  );

  it("does not turn a failed event followed by a ready event into success", async () => {
    const text = frame({ step: 0, name: "iam_role", status: "failed" }) + frame(ready);
    await expect(readProvisioningStream(new Response(text), () => {})).rejects.toMatchObject({ reason: "failed" });
  });

  it("reports an expired session distinctly", async () => {
    await expect(readProvisioningStream(new Response(null, { status: 401 }), () => {}))
      .rejects.toMatchObject({ reason: "session" });
  });

  it("keeps actionable department-policy rejection details", async () => {
    const reply = Response.json({ error: "Tier power is not allowed for your department" }, { status: 403 });
    await expect(readProvisioningStream(reply, () => {})).rejects.toMatchObject({
      reason: "failed", publicMessage: "Tier power is not allowed for your department",
    });
  });

  it("releases the stream after a terminal event without waiting for the server to close", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame(ready))); },
      cancel,
    });
    await expect(readProvisioningStream(new Response(stream), () => {})).resolves.toBe(ready.url);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
