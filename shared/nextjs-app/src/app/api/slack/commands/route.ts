/**
 * Slack Slash Commands handler
 * /ask {prompt} — query AI Assistant
 * /status — check CC-on-Bedrock system status
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest, postMessage, callAiRuntime } from "@/lib/slack-client";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Verify Slack request signature
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse URL-encoded form data
  const params = new URLSearchParams(rawBody);
  const command = params.get("command") ?? "";
  const text = params.get("text") ?? "";
  const channelId = params.get("channel_id") ?? "";
  const userId = params.get("user_id") ?? "";

  if (command === "/ask") {
    if (!text.trim()) {
      return new NextResponse("Usage: `/ask <질문>`", { status: 200 });
    }

    // Acknowledge immediately (Slack 3s timeout)
    // Then process in background
    callAiRuntime(text)
      .then((response) => postMessage(channelId, `<@${userId}> ${response}`))
      .catch((err) =>
        postMessage(channelId, `<@${userId}> Error: ${(err as Error).message}`)
      );

    return new NextResponse("Processing...", { status: 200 });
  }

  if (command === "/status") {
    const statusMsg = [
      "*CC-on-Bedrock Status*",
      `Region: \`ap-northeast-2\``,
      `Architecture: \`CloudFront → NLB → Nginx → ECS\``,
      `AI: \`Direct Bedrock (Opus 4.6 / Sonnet 4.6)\``,
    ].join("\n");

    return new NextResponse(statusMsg, { status: 200 });
  }

  return new NextResponse(`Unknown command: ${command}`, { status: 200 });
}
