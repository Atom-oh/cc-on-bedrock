import type { ContainerInfo } from "./types";

export class PortalStatusError extends Error {
  constructor(public readonly status: number) {
    super("Unable to verify the environment status");
  }
}

/** An unavailable or malformed response must never mean "no environment". */
export async function readContainerStatus(response: Response): Promise<ContainerInfo | null> {
  if (!response.ok) throw new PortalStatusError(response.status);
  const result = await response.json().catch(() => null);
  if (result?.success !== true || !Object.prototype.hasOwnProperty.call(result, "data")) {
    throw new PortalStatusError(response.status);
  }
  if (result.data === null) return null;
  if (typeof result.data !== "object" || typeof result.data.status !== "string" ||
      typeof result.data.taskId !== "string") {
    throw new PortalStatusError(response.status);
  }
  return result.data;
}
