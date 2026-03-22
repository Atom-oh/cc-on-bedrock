"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  tokens?: number;
}

const PRESETS_KO = [
  "가장 많은 비용을 사용한 사용자 TOP 5와 사용 패턴을 분석해주세요",
  "현재 시스템 상태와 주의가 필요한 항목을 요약해주세요",
  "API Key 예산 사용률을 분석하고 초과 위험이 있는 키를 알려주세요",
  "사용자별 모델 선호도와 토큰 효율성을 비교 분석해주세요",
  "현재 컨테이너 리소스 사용 현황과 최적화 제안을 해주세요",
  "월간 비용 예측과 비용 절감 방안을 제안해주세요",
];

const PRESETS_EN = [
  "Analyze the top 5 users by cost and their usage patterns",
  "Summarize current system health and items requiring attention",
  "Analyze API key budget utilization and identify keys at risk of overage",
  "Compare model preferences and token efficiency across users",
  "Review container resource usage and suggest optimizations",
  "Forecast monthly costs and recommend cost reduction strategies",
];

// Render markdown as React elements (safe, no innerHTML)
function MarkdownText({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} className="text-sm font-semibold text-gray-200 mt-3 mb-1">{formatInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} className="text-base font-semibold text-gray-100 mt-4 mb-2">{formatInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={i} className="text-lg font-bold text-white mt-4 mb-2">{formatInline(line.slice(2))}</h1>);
    } else if (line.startsWith("```")) {
      // Code block
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={i} className="bg-gray-900 border border-gray-700 rounded-lg p-3 overflow-x-auto my-2 text-xs">
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
    } else if (line.startsWith("- ")) {
      elements.push(<li key={i} className="ml-4 list-disc text-gray-300 text-sm">{formatInline(line.slice(2))}</li>);
    } else if (/^\d+\. /.test(line)) {
      elements.push(<li key={i} className="ml-4 list-decimal text-gray-300 text-sm">{formatInline(line.replace(/^\d+\. /, ""))}</li>);
    } else if (line.startsWith("|") && line.endsWith("|")) {
      // Table - collect rows
      const tableRows: string[][] = [];
      let j = i;
      while (j < lines.length && lines[j].startsWith("|")) {
        const cells = lines[j].split("|").filter(Boolean).map((c) => c.trim());
        if (!cells.every((c) => /^[-:]+$/.test(c))) {
          tableRows.push(cells);
        }
        j++;
      }
      elements.push(
        <table key={i} className="w-full my-2 text-xs border-collapse">
          <tbody>
            {tableRows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? "bg-gray-800/50" : ""}>
                {row.map((cell, ci) => {
                  const Tag = ri === 0 ? "th" : "td";
                  return <Tag key={ci} className="px-2 py-1 border border-gray-700 text-gray-300">{cell}</Tag>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
      i = j - 1;
    } else if (line.trim() === "") {
      elements.push(<br key={i} />);
    } else {
      elements.push(<p key={i} className="text-sm text-gray-300 leading-relaxed">{formatInline(line)}</p>);
    }
  }

  return <>{elements}</>;
}

function formatInline(text: string): React.ReactNode {
  // Split by bold (**text**) and code (`text`)
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="text-gray-100 font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="bg-gray-800 px-1 py-0.5 rounded text-cyan-300 text-xs">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export default function AIAssistant() {
  const { locale } = useI18n();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [toolStatus, setToolStatus] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const presets = locale === "ko" ? PRESETS_KO : PRESETS_EN;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, streamText, scrollToBottom]);

  const sendMessage = async (text?: string) => {
    const content = text ?? input.trim();
    if (!content || loading) return;

    const userMsg: Message = { role: "user", content, timestamp: new Date().toISOString() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setStreamText("");
    setToolStatus("");

    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
          lang: locale,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let fullText = "";
      let outputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n").filter((l) => l.startsWith("data: "))) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.text) { fullText += data.text; setStreamText(fullText); setToolStatus(""); }
            if (data.status) { setToolStatus(data.status as string); }
            if (data.usage) { outputTokens = data.usage.output_tokens ?? data.usage.outputTokens ?? 0; }
          } catch { /* ignore */ }
        }
      }

      setMessages([...newMessages, { role: "assistant", content: fullText, timestamp: new Date().toISOString(), tokens: outputTokens }]);
      setStreamText("");
    } catch (err) {
      setMessages([...newMessages, { role: "assistant", content: `❌ Error: ${err instanceof Error ? err.message : "Unknown"}`, timestamp: new Date().toISOString() }]);
      setStreamText("");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-cyan-500/10">
            <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">AI Assistant</h1>
            <p className="text-[10px] text-gray-500">Powered by Claude Sonnet 4.6 on Bedrock</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium rounded-full bg-cyan-500/10 text-cyan-400">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Sonnet 4.6
          </span>
          {messages.length > 0 && (
            <button onClick={() => setMessages([])} className="px-2 py-1 text-[10px] text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 space-y-4">
        {messages.length === 0 && !loading && (
          <div className="space-y-6 pt-8">
            <div className="text-center">
              <div className="inline-flex p-3 rounded-2xl bg-cyan-500/5 mb-3">
                <svg className="w-8 h-8 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-200">
                {locale === "ko" ? "무엇을 분석할까요?" : "What would you like to analyze?"}
              </h2>
              <p className="text-xs text-gray-500 mt-1">
                {locale === "ko" ? "사용자 현황, 비용 분석, 시스템 상태 등을 자연어로 질문하세요" : "Ask about user activity, cost analysis, system health, and more"}
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-2xl mx-auto px-4">
              {presets.map((preset, i) => (
                <button key={i} onClick={() => void sendMessage(preset)}
                  className="text-left p-3 rounded-lg bg-[#111827] border border-gray-800/50 hover:border-cyan-500/30 hover:bg-[#151d2e] text-xs text-gray-300 transition-all">
                  {preset}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
            {msg.role === "assistant" && (
              <div className="shrink-0 w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center mt-1">
                <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
            )}
            <div className={`max-w-[75%] rounded-xl px-4 py-3 ${
              msg.role === "user" ? "bg-blue-600 text-white" : "bg-[#111827] border border-gray-800/50 text-gray-200"
            }`}>
              {msg.role === "assistant" ? <MarkdownText text={msg.content} /> : <p className="text-sm whitespace-pre-wrap">{msg.content}</p>}
              {msg.tokens && msg.tokens > 0 && <p className="mt-2 text-[9px] text-gray-600">{msg.tokens} tokens</p>}
            </div>
            {msg.role === "user" && (
              <div className="shrink-0 w-7 h-7 rounded-lg bg-blue-600/20 flex items-center justify-center mt-1">
                <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                </svg>
              </div>
            )}
          </div>
        ))}

        {loading && streamText && (
          <div className="flex gap-3">
            <div className="shrink-0 w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center mt-1">
              <svg className="w-4 h-4 text-cyan-400 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <div className="max-w-[75%] rounded-xl px-4 py-3 bg-[#111827] border border-gray-800/50 text-gray-200">
              <MarkdownText text={streamText} />
              <span className="inline-block w-1.5 h-4 bg-cyan-400 animate-pulse ml-0.5" />
            </div>
          </div>
        )}

        {loading && !streamText && (
          <div className="flex gap-3 items-center">
            <div className="shrink-0 w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center">
              <svg className="w-4 h-4 text-cyan-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <div>
              <span className="text-sm text-gray-500 animate-pulse">
                {toolStatus || (locale === "ko" ? "플랫폼 데이터를 분석하고 있습니다..." : "Analyzing platform data...")}
              </span>
            </div>
          </div>
        )}

        {loading && streamText && toolStatus && (
          <div className="flex gap-2 items-center ml-10 -mt-2">
            <svg className="w-3 h-3 text-amber-400 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-[10px] text-amber-400">{toolStatus}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="pt-3 border-t border-gray-800">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={locale === "ko" ? "질문을 입력하세요... (Enter로 전송)" : "Ask a question... (Enter to send)"}
            rows={1}
            className="flex-1 px-4 py-2.5 text-sm bg-[#111827] border border-gray-800 text-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-transparent placeholder-gray-600 resize-none"
            disabled={loading}
          />
          <button
            onClick={() => void sendMessage()}
            disabled={loading || !input.trim()}
            className="px-4 py-2.5 rounded-xl bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
