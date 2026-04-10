/**
 * Slack Events API handler
 * Receives: url_verification, app_mention, message (DM)
 * Calls /api/ai/runtime and replies in Slack thread
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest, postMessage, callAiRuntime } from "@/lib/slack-client";

interface SlackEvent {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    user?: string;
    bot_id?: string;
  };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Verify Slack request signature
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as SlackEvent;

  // URL Verification challenge (Slack app setup)
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Handle events
  if (body.type === "event_callback" && body.event) {
    const event = body.event;

    // Ignore bot messages to avoid loops
    if (event.bot_id) {
      return NextResponse.json({ ok: true });
    }

    // Handle app_mention and DM messages
    if (event.type === "app_mention" || event.type === "message") {
      // Strip bot mention from text
      const prompt = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!prompt) {
        return NextResponse.json({ ok: true });
      }

      // Respond asynchronously — Slack requires 3s response
      // Process in background via waitUntil pattern
      const channel = event.channel;
      const threadTs = event.thread_ts ?? event.ts;

      // Post thinking indicator
      postMessage(channel, "...", threadTs).catch(() => {});

      // Call AI Runtime and reply
      callAiRuntime(prompt)
        .then((response) => postMessage(channel, response, threadTs))
        .catch((err) =>
          postMessage(channel, `Error: ${(err as Error).message}`, threadTs)
        );

      return NextResponse.json({ ok: true });
    }
  }

  return NextResponse.json({ ok: true });
}
