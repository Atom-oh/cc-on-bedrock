import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
  type ContentBlock,
  type ToolConfiguration,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { listInstances } from "@/lib/ec2-clients";
import { getEc2AggregateMetrics } from "@/lib/cloudwatch-client";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const MODEL_ID = "global.anthropic.claude-sonnet-4-6";

function getBedrockClient() {
  return new BedrockRuntimeClient({ region });
}

// ── Gather platform context (no LiteLLM dependency) ──
async function gatherContext(): Promise<string> {
  try {
    const instances = await listInstances().catch(() => []);
    const running = instances.filter((i) => i.status === "running");
    const runningIds = running.map((i) => i.instanceId);
    const cwMetrics = runningIds.length > 0
      ? await getEc2AggregateMetrics(runningIds).catch(() => null)
      : null;

    const instanceLines = running.map((i) =>
      `${i.username || i.subdomain}: ${i.instanceType} (${i.status})`
    ).join("\n");

    let cwLines = "N/A";
    if (cwMetrics) {
      cwLines = `CPU: ${cwMetrics.avgCpu.toFixed(1)}%, Memory: ${cwMetrics.avgMemory.toFixed(1)}%, Instances: ${cwMetrics.instanceCount}`;
    }

    return `[Platform Data - Direct Bedrock Mode]
Architecture: Claude Code → EC2 Instance Role → Bedrock (direct, no proxy)
Instances: ${running.length}/${instances.length} running
${instanceLines}
Aggregate Metrics: ${cwLines}
Region: ${region}
Note: Usage tracking via CloudTrail (data may have 1-5 min delay)`;
  } catch {
    return "[Platform data unavailable]";
  }
}

// ── Tool definitions ──
const toolConfig: ToolConfiguration = {
  tools: [
    { toolSpec: { name: "get_container_status", description: "Get ECS container status, user assignments, OS type, resource tier for all running development environments", inputSchema: { json: { type: "object", properties: {}, required: [] } } } },
    { toolSpec: { name: "get_container_metrics", description: "Get CloudWatch CPU, Memory, Network metrics for the ECS cluster", inputSchema: { json: { type: "object", properties: {}, required: [] } } } },
    { toolSpec: { name: "get_platform_summary", description: "Get overall platform summary including architecture, container status, and cluster health", inputSchema: { json: { type: "object", properties: {}, required: [] } } } },
  ],
};

async function executeTool(toolName: string): Promise<string> {
  try {
    switch (toolName) {
      case "get_container_status": {
        const inst = await listInstances();
        const runningInst = inst.filter((x) => x.status === "running");
        const typeDist: Record<string, number> = {};
        for (const r of runningInst) {
          typeDist[r.instanceType] = (typeDist[r.instanceType] ?? 0) + 1;
        }
        return JSON.stringify({
          total: inst.length,
          running: runningInst.length,
          typeDist,
          instances: inst.map((x) => ({
            user: x.username || x.subdomain,
            status: x.status,
            instanceType: x.instanceType,
            ip: x.privateIp,
            launchTime: x.launchTime,
          })),
        });
      }
      case "get_container_metrics": {
        const allInstances = await listInstances().catch(() => []);
        const allRunning = allInstances.filter((i) => i.status === "running");
        const m = await getEc2AggregateMetrics(allRunning.map((i) => i.instanceId));
        return JSON.stringify({
          cpu_pct: m.avgCpu.toFixed(1),
          mem_pct: m.avgMemory.toFixed(1),
          network_rx_bytes: m.totalNetworkRx,
          network_tx_bytes: m.totalNetworkTx,
          instances: m.instanceCount,
        });
      }
      case "get_platform_summary": {
        return await gatherContext();
      }
      default: return JSON.stringify({ error: "Unknown tool" });
    }
  } catch (e) { return JSON.stringify({ error: String(e) }); }
}

// ── Converse API with tool use ──
async function converseWithTools(
  userMessages: { role: string; content: string }[],
  lang: string,
  send: (data: Record<string, unknown>) => void,
): Promise<void> {
  const systemPrompt = `You are CC-on-Bedrock AI Assistant. You manage a multi-user Claude Code platform on AWS Bedrock.
Architecture: Users run Claude Code in ECS containers with direct Bedrock access via Task Roles. No proxy.
Use tools to get current data before answering. ${lang === "ko" ? "Respond in Korean." : "Respond in English."}
Use markdown tables for comparisons. Format numbers clearly.`;

  const messages: Message[] = userMessages.map(m => ({
    role: m.role as "user" | "assistant",
    content: [{ text: m.content }],
  }));

  for (let iteration = 0; iteration < 5; iteration++) {
    try {
      const cmd = new ConverseStreamCommand({
        modelId: MODEL_ID, system: [{ text: systemPrompt }],
        messages, toolConfig, inferenceConfig: { maxTokens: 4096 },
      });

      const resp = await getBedrockClient().send(cmd);
      let text = "";
      let stopReason = "";
      const toolCalls: { id: string; name: string }[] = [];
      let currentToolId = "";
      let currentToolName = "";

      if (resp.stream) {
        for await (const ev of resp.stream) {
          if (ev.contentBlockDelta?.delta?.text) {
            text += ev.contentBlockDelta.delta.text;
            send({ text: ev.contentBlockDelta.delta.text });
          }
          if (ev.contentBlockStart?.start?.toolUse) {
            currentToolId = ev.contentBlockStart.start.toolUse.toolUseId ?? "";
            currentToolName = ev.contentBlockStart.start.toolUse.name ?? "";
            send({ status: `tool: ${currentToolName}` });
          }
          if (ev.contentBlockStop && currentToolName) {
            toolCalls.push({ id: currentToolId, name: currentToolName });
            currentToolName = "";
            currentToolId = "";
          }
          if (ev.messageStop) stopReason = ev.messageStop.stopReason ?? "";
          if (ev.metadata?.usage) send({ usage: ev.metadata.usage });
        }
      }

      if (stopReason === "tool_use" && toolCalls.length > 0) {
        const assistantContent: ContentBlock[] = [];
        if (text) assistantContent.push({ text });
        for (const tc of toolCalls) {
          assistantContent.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: {} } });
        }
        messages.push({ role: "assistant", content: assistantContent });

        const toolResults: ContentBlock[] = [];
        for (const tc of toolCalls) {
          const result = await executeTool(tc.name);
          toolResults.push({
            toolResult: {
              toolUseId: tc.id,
              content: [{ text: result }] as ToolResultContentBlock[],
            },
          });
        }
        messages.push({ role: "user", content: toolResults });
        send({ status: "" });
        continue;
      }

      break;
    } catch (err) {
      console.error(`[AI] Converse iteration ${iteration}:`, (err as Error).message);
      send({ text: `\n\nError: ${(err as Error).message}` });
      break;
    }
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  let body: { messages: { role: string; content: string }[]; lang?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  const { messages: userMessages, lang = "ko" } = body;

  let controllerClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        if (controllerClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { controllerClosed = true; }
      };

      try {
        send({ status: "Analyzing with Claude Sonnet 4.6..." });
        await converseWithTools(userMessages.slice(-8), lang, send);
        send({ status: "" });
        send({ done: true, via: "Bedrock Converse + Tool Use (Direct)" });
      } catch (err) {
        console.error("[AI Route]", (err as Error).message);
        try { send({ text: `Error: ${(err as Error).message}` }); send({ done: true }); } catch {}
      } finally {
        if (!controllerClosed) { try { controller.close(); } catch {} }
        controllerClosed = true;
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
