/**
 * AI Assistant Runtime API Route (for Slack / External clients)
 * Architecture: Client → InvokeAgentRuntime → Gateway (MCP) → Lambda Tools
 *
 * This endpoint is for external integrations (Slack, CLI, API clients).
 * Dashboard uses /api/ai (Converse API direct) for faster streaming.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { authOptions } from "@/lib/auth";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN ?? "";
const GATEWAY_URL = process.env.AGENTCORE_GATEWAY_URL ?? "";

function getClient() {
  return new BedrockAgentCoreClient({ region });
}

export async function POST(req: NextRequest) {
  // Session auth (dashboard) OR API key auth (external clients like Slack)
  const session = await getServerSession(authOptions);
  const authHeader = req.headers.get("authorization");
  const apiKey = process.env.RUNTIME_API_KEY;

  if (!session?.user && !(apiKey && authHeader === `Bearer ${apiKey}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { messages, prompt, lang = "ko" } = body as {
      messages?: { role: string; content: string }[];
      prompt?: string;
      lang?: string;
    };

    // Build payload for Runtime
    const runtimePayload: Record<string, unknown> = {
      gateway_url: GATEWAY_URL,
    };

    if (messages && messages.length > 0) {
      runtimePayload.messages = messages.slice(-8).map((m) => ({
        role: m.role,
        content: m.content + (m.role === "user" && lang === "ko" ? "\n(한국어로 응답해주세요)" : ""),
      }));
    } else if (prompt) {
      runtimePayload.prompt = prompt + (lang === "ko" ? "\n(한국어로 응답해주세요)" : "");
    } else {
      return NextResponse.json({ error: "messages or prompt required" }, { status: 400 });
    }

    const cmd = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      qualifier: "DEFAULT",
      payload: JSON.stringify(runtimePayload),
    });

    const resp = await getClient().send(cmd);

    // Read response
    const responseBody = resp.response;
    let resultText = "";

    if (typeof responseBody === "string") {
      resultText = responseBody;
    } else if (responseBody && typeof responseBody === "object") {
      const body = responseBody as unknown as Record<string, unknown>;
      if (typeof body.transformToString === "function") {
        resultText = await (body.transformToString as () => Promise<string>)();
      } else if (typeof body.transformToByteArray === "function") {
        const bytes = await (body.transformToByteArray as () => Promise<Uint8Array>)();
        resultText = new TextDecoder().decode(bytes);
      } else {
        resultText = JSON.stringify(body);
      }
    }

    // Clean JSON string wrapping
    if (resultText.startsWith('"') && resultText.endsWith('"')) {
      try {
        resultText = JSON.parse(resultText) as string;
      } catch {
        // Keep as is
      }
    }

    return NextResponse.json({
      success: true,
      response: resultText,
      via: "AgentCore Runtime + MCP Gateway",
      runtimeSessionId: resp.runtimeSessionId,
    });
  } catch (err) {
    console.error("[AI Runtime]", (err as Error).message);
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
