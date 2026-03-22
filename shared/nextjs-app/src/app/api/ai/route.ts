import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { getSpendLogs, getKeySpendList } from "@/lib/litellm-client";

const AGENTCORE_REGION = process.env.AGENTCORE_REGION ?? process.env.AWS_REGION ?? "ap-northeast-2";
const AGENT_RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN ?? "";
const AGENTCORE_TIMEOUT_MS = 90000;

const agentCoreClient = new BedrockAgentCoreClient({ region: AGENTCORE_REGION });

function getAgentRuntimeArn(): string {
  if (AGENT_RUNTIME_ARN) return AGENT_RUNTIME_ARN;
  // Fallback: CC-on-Bedrock agent
  const accountId = "061525506239";
  return `arn:aws:bedrock-agentcore:${AGENTCORE_REGION}:${accountId}:runtime/cconbedrock_agent-xcceE4DydC`;
}

// Gather LiteLLM context to inject into prompt (gateway doesn't have LiteLLM access)
async function getLiteLLMContext(): Promise<string> {
  try {
    const [logs, keys] = await Promise.all([
      getSpendLogs().catch(() => []),
      getKeySpendList().catch(() => []),
    ]);

    const keyMap = new Map<string, string>();
    for (const k of keys) {
      const tail = (k.token ?? "").slice(-8);
      const user = (k.metadata as Record<string, string>)?.user ?? k.key_alias?.replace("-key", "") ?? "";
      if (tail) keyMap.set(tail, user);
    }

    const userStats = new Map<string, { requests: number; tokens: number; spend: number }>();
    for (const log of logs) {
      const tail = log.api_key?.slice(-8) ?? "";
      const user = keyMap.get(tail) ?? (tail || "unknown");
      const stat = userStats.get(user) ?? { requests: 0, tokens: 0, spend: 0 };
      stat.requests += 1;
      stat.tokens += log.total_tokens ?? 0;
      stat.spend += log.spend ?? 0;
      userStats.set(user, stat);
    }

    const totalSpend = logs.reduce((s, l) => s + (l.spend ?? 0), 0);
    const userLines = [...userStats.entries()]
      .sort(([, a], [, b]) => b.spend - a.spend)
      .map(([u, s]) => `${u}: ${s.requests}req, ${s.tokens}tok, $${s.spend.toFixed(4)}`)
      .join("\n");

    const keyLines = keys.filter(k => k.key_alias).map(k => {
      const user = (k.metadata as Record<string, string>)?.user ?? k.key_alias;
      const pct = k.max_budget ? `${((k.spend / k.max_budget) * 100).toFixed(1)}%` : "unlimited";
      return `${user}: spend=$${k.spend.toFixed(4)}, budget=$${k.max_budget ?? "∞"}, usage=${pct}`;
    }).join("\n");

    return `\n[CC-on-Bedrock LiteLLM Data]\nTotal: ${logs.length} requests, $${totalSpend.toFixed(4)} spend, ${userStats.size} users\nPer-user:\n${userLines}\nAPI Key Budgets:\n${keyLines}`;
  } catch {
    return "\n[LiteLLM data unavailable]";
  }
}

async function streamToString(stream: unknown): Promise<string> {
  if (!stream) return "";

  // Handle async iterable streams
  if (typeof stream === "object" && stream !== null && Symbol.asyncIterator in (stream as Record<symbol, unknown>)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  // Handle transformToByteArray
  if (typeof stream === "object" && stream !== null && "transformToByteArray" in (stream as Record<string, unknown>)) {
    const bytes = await (stream as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return new TextDecoder().decode(bytes);
  }

  return String(stream);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.json();
  const { messages: userMessages, lang = "ko", gateway = "monitoring" } = body as {
    messages: { role: string; content: string }[];
    lang?: string;
    gateway?: string;
  };

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Get LiteLLM context
        send({ status: "🔍 Fetching platform data..." });
        const litellmContext = await getLiteLLMContext();

        // Prepare messages for AgentCore
        const lastUserMsg = [...userMessages].reverse().find(m => m.role === "user")?.content ?? "";
        const enrichedPrompt = `${lastUserMsg}\n\n${litellmContext}\n\n[ECS Cluster: cc-on-bedrock-devenv, Region: ${AGENTCORE_REGION}]${lang === "ko" ? "\n[Please respond in Korean]" : ""}`;

        const recentMessages = userMessages.slice(-6).map(m => ({
          role: m.role,
          content: m.role === "user" && m === userMessages[userMessages.length - 1]
            ? enrichedPrompt
            : m.content,
        }));

        // Invoke AgentCore Runtime
        send({ status: "🤖 AgentCore Runtime 호출 중..." });

        const agentPromise = (async () => {
          // Payload must be Uint8Array for the SDK
          const payloadStr = JSON.stringify({
            messages: recentMessages,
            gateway,
            prompt: enrichedPrompt,
          });

          const command = new InvokeAgentRuntimeCommand({
            agentRuntimeArn: getAgentRuntimeArn(),
            qualifier: "DEFAULT",
            payload: new TextEncoder().encode(payloadStr),
          });

          const response = await agentCoreClient.send(command);
          const sessionId = response.runtimeSessionId;

          send({ status: `⚡ Agent session: ${sessionId?.slice(-8) ?? "?"}` });

          // Read response - may be a stream or Uint8Array
          let responseBody = "";
          if (response.response) {
            if (response.response instanceof Uint8Array) {
              responseBody = new TextDecoder().decode(response.response);
            } else {
              responseBody = await streamToString(response.response);
            }
          }

          let text = responseBody;

          // Parse if JSON-wrapped (AgentCore returns {"result": "..."})
          try {
            const parsed = JSON.parse(responseBody);
            if (parsed.result) {
              // result may be a stringified dict or a plain string
              const result = parsed.result;
              if (typeof result === "string") {
                // Try to extract text content from Python dict format
                const contentMatch = result.match(/'text':\s*'([\s\S]*?)'\}\]/);
                if (contentMatch) {
                  text = contentMatch[1].replace(/\\n/g, "\n").replace(/\\'/g, "'");
                } else {
                  text = result;
                }
              } else {
                text = JSON.stringify(result);
              }
            } else if (parsed.message) {
              text = parsed.message;
            }
          } catch {
            // Use raw response
          }

          // Clean up session
          if (sessionId) {
            try {
              await agentCoreClient.send(new StopRuntimeSessionCommand({
                agentRuntimeArn: getAgentRuntimeArn(),
                runtimeSessionId: sessionId,
                qualifier: "DEFAULT",
              }));
            } catch {
              // Session cleanup is best-effort
            }
          }

          return text;
        })();

        // Timeout protection
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("AgentCore timeout (90s)")), AGENTCORE_TIMEOUT_MS);
        });

        const result = await Promise.race([agentPromise, timeoutPromise]);

        // Stream the result text
        send({ status: "" });
        // Send in chunks for streaming effect
        const chunkSize = 20;
        for (let i = 0; i < result.length; i += chunkSize) {
          send({ text: result.slice(i, i + chunkSize) });
          // Small delay for visual streaming effect
          await new Promise(r => setTimeout(r, 10));
        }

        send({ done: true, via: "agentcore-runtime", gateway });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Agent error";
        console.error("[AI Route] AgentCore error:", errorMsg);

        try {
          send({ status: "" });
          send({ text: `⚠️ AgentCore Runtime Error: ${errorMsg}` });
          send({ done: true, via: "error" });
        } catch {
          // Controller may already be closed
        }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
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
