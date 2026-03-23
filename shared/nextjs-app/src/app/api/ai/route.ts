import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
  type ContentBlock,
  type ToolConfiguration,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { getSpendLogs, getKeySpendList, getSystemHealth, getModelCount } from "@/lib/litellm-client";
import { listContainers } from "@/lib/aws-clients";
import { getContainerMetrics } from "@/lib/cloudwatch-client";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const AGENT_RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN ?? "";
const AGENTCORE_TIMEOUT_MS = 60000;
const MODEL_ID = "global.anthropic.claude-sonnet-4-6";

const agentCoreClient = new BedrockAgentCoreClient({ region });
const bedrockClient = new BedrockRuntimeClient({ region });

function getAgentRuntimeArn(): string {
  return AGENT_RUNTIME_ARN || `arn:aws:bedrock-agentcore:${region}:061525506239:runtime/cconbedrock_agent-xcceE4DydC`;
}

// ── Gather context for both AgentCore and fallback ──
async function gatherContext(): Promise<string> {
  try {
    const [logs, keys, health, modelCount, containers, cwMetrics] = await Promise.all([
      getSpendLogs().catch(() => []),
      getKeySpendList().catch(() => []),
      getSystemHealth().catch(() => null),
      getModelCount().catch(() => 0),
      listContainers().catch(() => []),
      getContainerMetrics().catch(() => null),
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
      return `${user}: $${k.spend.toFixed(4)} / $${k.max_budget ?? "∞"} (${pct})`;
    }).join("\n");

    const running = containers.filter(c => c.status === "RUNNING");
    const containerLines = running.map(c => `${c.username || c.subdomain}: ${c.containerOs}/${c.resourceTier}`).join("\n");

    let cwLines = "N/A";
    if (cwMetrics) {
      cwLines = `CPU: ${cwMetrics.cpuUtilizationPct.toFixed(1)}%, Memory: ${cwMetrics.memoryUtilizationPct.toFixed(1)}%, Tasks: ${cwMetrics.taskCount}`;
    }

    return `[Platform Data]
System: ${health?.status ?? "?"}, DB: ${health?.db ?? "?"}, Cache: ${health?.cache ?? "?"}, LiteLLM: v${health?.litellm_version ?? "?"}, Models: ${modelCount}
Usage: ${logs.length} requests, $${totalSpend.toFixed(4)} total, ${userStats.size} users
Per-user:\n${userLines}
API Key Budgets:\n${keyLines}
Containers: ${running.length}/${containers.length} running\n${containerLines}
Cluster: ${cwLines}`;
  } catch {
    return "[Platform data unavailable]";
  }
}

// ── Tool definitions for Converse API fallback ──
const toolConfig: ToolConfiguration = {
  tools: [
    { toolSpec: { name: "get_spend_summary", description: "Get spend/token data with per-user breakdown from LiteLLM", inputSchema: { json: {} } } },
    { toolSpec: { name: "get_api_key_budgets", description: "Get API key budget status, utilization, limits", inputSchema: { json: {} } } },
    { toolSpec: { name: "get_system_health", description: "Get proxy/DB/cache/model health status", inputSchema: { json: {} } } },
    { toolSpec: { name: "get_container_status", description: "Get ECS container status and user assignments", inputSchema: { json: {} } } },
    { toolSpec: { name: "get_container_metrics", description: "Get CloudWatch CPU/Memory/Network metrics", inputSchema: { json: {} } } },
  ],
};

async function executeTool(toolName: string): Promise<string> {
  try {
    switch (toolName) {
      case "get_spend_summary": {
        const [logs, keys] = await Promise.all([getSpendLogs(), getKeySpendList()]);
        const km = new Map<string, string>();
        for (const k of keys) { const t = (k.token ?? "").slice(-8); if (t) km.set(t, (k.metadata as Record<string, string>)?.user ?? k.key_alias?.replace("-key", "") ?? ""); }
        const us = new Map<string, { req: number; tok: number; spend: number }>();
        for (const l of logs) { const u = km.get(l.api_key?.slice(-8) ?? "") ?? "unknown"; const s = us.get(u) ?? { req: 0, tok: 0, spend: 0 }; s.req++; s.tok += l.total_tokens ?? 0; s.spend += l.spend ?? 0; us.set(u, s); }
        return JSON.stringify({ total: logs.length, spend: logs.reduce((s, l) => s + (l.spend ?? 0), 0), users: Object.fromEntries([...us.entries()].sort(([, a], [, b]) => b.spend - a.spend)) });
      }
      case "get_api_key_budgets": {
        const keys = await getKeySpendList();
        return JSON.stringify(keys.filter(k => k.key_alias).map(k => ({ user: (k.metadata as Record<string, string>)?.user ?? k.key_alias, spend: k.spend, budget: k.max_budget, pct: k.max_budget ? `${((k.spend / k.max_budget) * 100).toFixed(1)}%` : "∞" })));
      }
      case "get_system_health": {
        const [h, mc] = await Promise.all([getSystemHealth(), getModelCount()]);
        return JSON.stringify({ ...h, model_count: mc });
      }
      case "get_container_status": {
        const c = await listContainers();
        return JSON.stringify({ total: c.length, running: c.filter(x => x.status === "RUNNING").length, containers: c.map(x => ({ user: x.username || x.subdomain, status: x.status, os: x.containerOs, tier: x.resourceTier })) });
      }
      case "get_container_metrics": {
        const m = await getContainerMetrics();
        return JSON.stringify({ cpu_pct: m.cpuUtilizationPct.toFixed(1), mem_pct: m.memoryUtilizationPct.toFixed(1), tasks: m.taskCount, hosts: m.containerInstanceCount });
      }
      default: return JSON.stringify({ error: "Unknown tool" });
    }
  } catch (e) { return JSON.stringify({ error: String(e) }); }
}

// ── Converse API fallback with tool use ──
async function converseWithTools(
  userMessages: { role: string; content: string }[],
  lang: string,
  send: (data: Record<string, unknown>) => void,
): Promise<void> {
  const systemPrompt = `You are CC-on-Bedrock AI Assistant. You analyze a multi-user Claude Code platform on AWS Bedrock.
ALWAYS use tools to get current data before answering. ${lang === "ko" ? "Respond in Korean." : "Respond in English."}
Use markdown tables for comparisons. Highlight warnings.`;

  let messages: Message[] = userMessages.map(m => ({
    role: m.role as "user" | "assistant",
    content: [{ text: m.content }],
  }));

  for (let i = 0; i < 5; i++) {
    const cmd = new ConverseStreamCommand({
      modelId: MODEL_ID, system: [{ text: systemPrompt }],
      messages, toolConfig, inferenceConfig: { maxTokens: 4096 },
    });

    const resp = await bedrockClient.send(cmd);
    let text = "", toolId = "", toolName = "", stopReason = "";

    if (resp.stream) {
      for await (const ev of resp.stream) {
        if (ev.contentBlockDelta?.delta?.text) { text += ev.contentBlockDelta.delta.text; send({ text: ev.contentBlockDelta.delta.text }); }
        if (ev.contentBlockStart?.start?.toolUse) { toolId = ev.contentBlockStart.start.toolUse.toolUseId ?? ""; toolName = ev.contentBlockStart.start.toolUse.name ?? ""; send({ status: `🔧 ${toolName}...` }); }
        if (ev.messageStop) stopReason = ev.messageStop.stopReason ?? "";
        if (ev.metadata?.usage) send({ usage: ev.metadata.usage });
      }
    }

    if (stopReason === "tool_use" && toolName) {
      const assistantContent: ContentBlock[] = [];
      if (text) assistantContent.push({ text });
      assistantContent.push({ toolUse: { toolUseId: toolId, name: toolName, input: {} } });
      messages.push({ role: "assistant", content: assistantContent });
      send({ status: `⚡ ${toolName}...` });
      const result = await executeTool(toolName);
      const toolResult: ToolResultContentBlock[] = [{ text: result }];
      messages.push({ role: "user", content: [{ toolResult: { toolUseId: toolId, content: toolResult } }] });
      continue;
    }
    break;
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    return new Response(JSON.stringify({ error: "Admin access required" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }

  const body = await req.json();
  const { messages: userMessages, lang = "ko" } = body as { messages: { role: string; content: string }[]; lang?: string };

  let controllerClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: Record<string, unknown>) => {
        if (controllerClosed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { controllerClosed = true; }
      };

      try {
        // Try AgentCore Runtime first
        send({ status: "🤖 AgentCore Runtime..." });
        const context = await gatherContext();
        const lastMsg = [...userMessages].reverse().find(m => m.role === "user")?.content ?? "";
        const enrichedPrompt = `${lastMsg}\n\n${context}${lang === "ko" ? "\n[Korean으로 답변]" : ""}`;

        const agentPromise = (async () => {
          const cmd = new InvokeAgentRuntimeCommand({
            agentRuntimeArn: getAgentRuntimeArn(),
            qualifier: "DEFAULT",
            payload: new TextEncoder().encode(JSON.stringify({ prompt: enrichedPrompt })),
          });
          const resp = await agentCoreClient.send(cmd);
          const sid = resp.runtimeSessionId;

          let body = "";
          if (resp.response instanceof Uint8Array) body = new TextDecoder().decode(resp.response);
          else if (resp.response && Symbol.asyncIterator in (resp.response as object)) {
            const chunks: Uint8Array[] = [];
            for await (const c of resp.response as AsyncIterable<Uint8Array>) chunks.push(c);
            body = new TextDecoder().decode(Buffer.concat(chunks));
          } else body = String(resp.response ?? "");

          if (sid) { try { await agentCoreClient.send(new StopRuntimeSessionCommand({ agentRuntimeArn: getAgentRuntimeArn(), runtimeSessionId: sid, qualifier: "DEFAULT" })); } catch {} }

          let text = body;
          try { const p = JSON.parse(body); text = typeof p.result === "string" ? p.result : body; const m = text.match(/'text':\s*'([\s\S]*?)'\}\]/); if (m) text = m[1].replace(/\\n/g, "\n").replace(/\\'/g, "'"); } catch {}
          return text;
        })();

        const timeout = new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), AGENTCORE_TIMEOUT_MS));

        try {
          const result = await Promise.race([agentPromise, timeout]);
          send({ status: "" });
          for (let i = 0; i < result.length; i += 30) {
            send({ text: result.slice(i, i + 30) });
            await new Promise(r => setTimeout(r, 5));
          }
          send({ done: true, via: "agentcore" });
        } catch (agentErr) {
          // Fallback to Converse API with tool use
          console.error("[AI] AgentCore failed, falling back to Converse:", (agentErr as Error).message);
          send({ status: "🔄 Bedrock Converse fallback..." });
          await converseWithTools(userMessages.slice(-6), lang, send);
          send({ status: "" });
          send({ done: true, via: "converse-fallback" });
        }
      } catch (err) {
        console.error("[AI Route] Error:", (err as Error).message);
        try { send({ text: `⚠️ Error: ${(err as Error).message}` }); send({ done: true }); } catch {}
      } finally {
        if (!controllerClosed) { try { controller.close(); } catch {} }
        controllerClosed = true;
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
