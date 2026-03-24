/**
 * AI Assistant API Route
 * Architecture: Dashboard → AgentCore Runtime → Gateway (MCP) → Lambda Tools
 *
 * The Runtime handles: model selection, tool use loop, system prompt, conversation history
 * This route only: authenticates, invokes Runtime, streams response via SSE
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN
  ?? "arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/cconbedrock_assistant_v2-Rpg8UUGdQt";
const GATEWAY_URL = process.env.AGENTCORE_GATEWAY_URL
  ?? "https://cconbedrock-gateway-u1p3qlbsz6.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp";

function getClient() {
  return new BedrockAgentCoreClient({ region });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.json();
  const { messages: userMessages, lang = "ko" } = body as {
    messages: { role: string; content: string }[];
    lang?: string;
  };

  let controllerClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        if (controllerClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          controllerClosed = true;
        }
      };

      try {
        send({ status: "Connecting to AgentCore Runtime..." });

        // Build payload for Runtime
        const payload = JSON.stringify({
          messages: userMessages.slice(-8).map((m) => ({
            role: m.role,
            content: m.content + (m.role === "user" && lang === "ko" ? "\n(한국어로 응답해주세요)" : ""),
          })),
          gateway_url: GATEWAY_URL,
        });

        const cmd = new InvokeAgentRuntimeCommand({
          agentRuntimeArn: RUNTIME_ARN,
          qualifier: "DEFAULT",
          payload,
        });

        send({ status: "Analyzing with AgentCore + MCP Tools..." });

        const resp = await getClient().send(cmd);

        // Read response from Runtime
        const responseBody = resp.response;
        let resultText = "";

        if (responseBody && typeof responseBody === "object" && "read" in responseBody) {
          const raw = await (responseBody as { read: () => Promise<Uint8Array> }).read();
          resultText = new TextDecoder().decode(raw);
        } else if (typeof responseBody === "string") {
          resultText = responseBody;
        } else {
          resultText = String(responseBody ?? "No response from Runtime");
        }

        // Clean JSON string wrapping if present
        if (resultText.startsWith('"') && resultText.endsWith('"')) {
          try {
            resultText = JSON.parse(resultText);
          } catch {
            // Keep as is
          }
        }

        // Send the complete response as text chunks for SSE streaming effect
        const chunkSize = 50;
        for (let i = 0; i < resultText.length; i += chunkSize) {
          send({ text: resultText.slice(i, i + chunkSize) });
        }

        // Extract token usage from response metadata if available
        const inputTokens = 0; // Runtime doesn't expose token counts directly
        const outputTokens = 0;

        send({ status: "" });
        send({
          done: true,
          via: "AgentCore Runtime + MCP Gateway",
          inputTokens,
          outputTokens,
        });
      } catch (err) {
        console.error("[AI Route]", (err as Error).message);
        try {
          send({ text: `Error: ${(err as Error).message}` });
          send({ done: true });
        } catch {
          // Ignore
        }
      } finally {
        if (!controllerClosed) {
          try {
            controller.close();
          } catch {
            // Ignore
          }
        }
        controllerClosed = true;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
