import { describe, it, expect, vi } from "vitest";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { invokeLambdaAsync, invokeLambdaJson } from "../lambda-invoke";

const enc = (o: unknown) => new Uint8Array(Buffer.from(JSON.stringify(o)));

describe("invokeLambdaJson", () => {
  it("invokes RequestResponse with the JSON payload", async () => {
    const send = vi.fn(async (_c: InvokeCommand) => ({ Payload: enc({ accepted: 2 }) }));
    await expect(invokeLambdaJson("fn", { a: 1 }, send)).resolves.toEqual({ ok: true, body: { accepted: 2 } });
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.FunctionName).toBe("fn");
    expect(cmd.input.InvocationType).toBe("RequestResponse");
    expect(JSON.parse(Buffer.from(cmd.input.Payload as Uint8Array).toString())).toEqual({ a: 1 });
  });

  it("reports FunctionError with the error message", async () => {
    const send = vi.fn(async () => ({ FunctionError: "Unhandled", Payload: enc({ errorMessage: "Task timed out" }) }));
    await expect(invokeLambdaJson("fn", {}, send)).resolves.toEqual({ ok: false, error: "Task timed out" });
  });

  it("unwraps statusCode/body and treats non-2xx as an error", async () => {
    const ok = vi.fn(async () => ({ Payload: enc({ statusCode: 200, body: JSON.stringify({ x: 1 }) }) }));
    await expect(invokeLambdaJson("fn", {}, ok)).resolves.toEqual({ ok: true, body: { x: 1 } });
    const bad = vi.fn(async () => ({ Payload: enc({ statusCode: 400, body: JSON.stringify({ error: "nope" }) }) }));
    await expect(invokeLambdaJson("fn", {}, bad)).resolves.toEqual({ ok: false, error: "nope" });
  });
});

describe("invokeLambdaAsync", () => {
  it("invokes with InvocationType Event and the JSON payload", async () => {
    const send = vi.fn(async (_c: InvokeCommand) => ({ StatusCode: 202 }));
    await invokeLambdaAsync("insights", { date: "2026-11-03", force: true }, send);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.FunctionName).toBe("insights");
    expect(cmd.input.InvocationType).toBe("Event");
    expect(JSON.parse(Buffer.from(cmd.input.Payload as Uint8Array).toString())).toEqual({ date: "2026-11-03", force: true });
  });

  it("throws when the event is not accepted", async () => {
    const send = vi.fn(async () => ({ StatusCode: 500 }));
    await expect(invokeLambdaAsync("fn", {}, send)).rejects.toThrow(/500/);
  });

  it("propagates invoke errors", async () => {
    const send = vi.fn(async () => {
      throw new Error("AccessDenied");
    });
    await expect(invokeLambdaAsync("fn", {}, send)).rejects.toThrow("AccessDenied");
  });
});
