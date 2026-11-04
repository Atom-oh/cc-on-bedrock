// Synchronous (RequestResponse) Lambda invocation returning the parsed JSON result.
// A function error (FunctionError set: unhandled exception, timeout) is reported
// separately from the function's own return value so routes can map it to 502.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const lambda = new LambdaClient({ region });

type Send = (command: InvokeCommand) => Promise<{ FunctionError?: string; Payload?: Uint8Array; StatusCode?: number }>;
const defaultSend: Send = (command) => lambda.send(command);

export type LambdaResult =
  | { ok: true; body: unknown }
  | { ok: false; error: string };

export async function invokeLambdaJson(
  functionName: string,
  payload: unknown,
  send: Send = defaultSend
): Promise<LambdaResult> {
  const resp = await send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  const text = resp.Payload ? Buffer.from(resp.Payload).toString("utf8") : "";
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (resp.FunctionError) {
    const msg =
      parsed && typeof parsed === "object" && typeof (parsed as { errorMessage?: unknown }).errorMessage === "string"
        ? (parsed as { errorMessage: string }).errorMessage
        : resp.FunctionError;
    return { ok: false, error: msg.slice(0, 500) };
  }
  // API-Gateway-style `{statusCode, body}` wrapper: unwrap the body.
  if (parsed && typeof parsed === "object" && "statusCode" in parsed) {
    const status = Number((parsed as { statusCode: unknown }).statusCode);
    const bodyStr = (parsed as { body?: unknown }).body;
    let inner: unknown = bodyStr;
    if (typeof bodyStr === "string") {
      try {
        inner = JSON.parse(bodyStr);
      } catch {
        inner = { error: bodyStr };
      }
    }
    if (!(status >= 200 && status < 300)) {
      const err = inner && typeof inner === "object" && typeof (inner as { error?: unknown }).error === "string"
        ? (inner as { error: string }).error
        : `Lambda returned status ${status}`;
      return { ok: false, error: err.slice(0, 500) };
    }
    return { ok: true, body: inner };
  }
  return { ok: true, body: parsed };
}

/**
 * Asynchronous (Event) invocation: Lambda queues the event and answers 202 without
 * waiting for the function. Throws when the invoke is not accepted.
 */
export async function invokeLambdaAsync(
  functionName: string,
  payload: unknown,
  send: Send = defaultSend
): Promise<void> {
  const resp = await send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  if (resp.StatusCode !== undefined && resp.StatusCode !== 202) {
    throw new Error(`Lambda Event invoke returned status ${resp.StatusCode}`);
  }
}
