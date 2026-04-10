/**
 * Slack Client — verify requests and post messages
 */
import * as crypto from "crypto";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";

export function verifySlackRequest(
  body: string,
  timestamp: string,
  signature: string
): boolean {
  if (!SLACK_SIGNING_SECRET) return false;

  // Reject if timestamp is more than 5 minutes old
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const sigBaseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", SLACK_SIGNING_SECRET);
  hmac.update(sigBaseString);
  const computed = `v0=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

export async function postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
}

export async function callAiRuntime(prompt: string): Promise<string> {
  const RUNTIME_API_KEY = process.env.RUNTIME_API_KEY ?? "";
  const DASHBOARD_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

  const res = await fetch(`${DASHBOARD_URL}/api/ai/runtime`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RUNTIME_API_KEY}`,
    },
    body: JSON.stringify({ prompt, lang: "ko" }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI Runtime error (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { success: boolean; response?: string; error?: string };
  if (!data.success) throw new Error(data.error ?? "Unknown error");
  return data.response ?? "응답을 생성하지 못했습니다.";
}
