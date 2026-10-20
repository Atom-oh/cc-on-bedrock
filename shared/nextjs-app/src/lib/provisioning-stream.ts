import { PROVISIONING_STEPS, type ProvisioningEvent } from "./types";

export class ProvisioningStreamError extends Error {
  constructor(
    public readonly reason: "session" | "connection" | "failed",
    public readonly publicMessage?: string,
  ) {
    super(reason);
  }
}

/** Read until a terminal event, including events split across network chunks. */
export async function readProvisioningStream(
  response: Response,
  onEvent: (event: ProvisioningEvent) => void,
): Promise<string | undefined> {
  if (response.status === 401) throw new ProvisioningStreamError("session");
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = [400, 403, 409].includes(response.status) && typeof body?.error === "string"
      ? body.error.slice(0, 300) : undefined;
    throw new ProvisioningStreamError("failed", detail);
  }
  if (!response.body) throw new ProvisioningStreamError("failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (line: string): ProvisioningEvent | null => {
    if (!line.startsWith("data:")) return null;
    let event: ProvisioningEvent;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      throw new ProvisioningStreamError("connection");
    }
    if (!event || !Number.isInteger(event.step) ||
        !PROVISIONING_STEPS.some(step => step.name === event.name) ||
        !["pending", "in_progress", "completed", "failed"].includes(event.status)) {
      throw new ProvisioningStreamError("connection");
    }
    return event;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // A trailing event without a newline still needs to be handled at EOF.
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        const event = parseLine(line);
        if (!event) continue;
        onEvent(event);
        if (event.status === "failed") throw new ProvisioningStreamError("failed");
        if (event.status === "completed" && event.step === 7 && event.name === "health_check") {
          return event.url;
        }
      }
      if (done) throw new ProvisioningStreamError("connection");
      if (buffer.length > 64_000) throw new ProvisioningStreamError("connection");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
