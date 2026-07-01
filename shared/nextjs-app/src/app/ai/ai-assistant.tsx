"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/lib/i18n";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  inputTokens?: number;
  outputTokens?: number;
  tools?: string[];
  responseTime?: number;
  via?: string;
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

// Markdown renderer using react-markdown + remark-gfm
function MarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="text-lg font-bold text-white mt-4 mb-2">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-semibold text-gray-100 mt-4 mb-2">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-200 mt-3 mb-1">{children}</h3>,
        h4: ({ children }) => <h4 className="text-sm font-medium text-gray-300 mt-2 mb-1">{children}</h4>,
        p: ({ children }) => <p className="text-sm text-gray-300 leading-relaxed mb-2">{children}</p>,
        strong: ({ children }) => <strong className="text-gray-100 font-semibold">{children}</strong>,
        em: ({ children }) => <em className="text-gray-400 italic">{children}</em>,
        a: ({ href, children }) => <a href={href} className="text-cyan-400 hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>,
        ul: ({ children }) => <ul className="list-disc ml-4 mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal ml-4 mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-sm text-gray-300">{children}</li>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-cyan-500/50 pl-3 my-2 text-sm text-gray-400 italic">{children}</blockquote>,
        code: ({ className, children }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <pre className="bg-gray-900 border border-gray-700 rounded-lg p-3 overflow-x-auto my-2">
                <code className="text-xs text-gray-300">{children}</code>
              </pre>
            );
          }
          return <code className="bg-gray-800 px-1 py-0.5 rounded text-cyan-300 text-xs">{children}</code>;
        },
        pre: ({ children }) => <>{children}</>,
        table: ({ children }) => <table className="w-full my-2 text-xs border-collapse">{children}</table>,
        thead: ({ children }) => <thead className="bg-gray-800/50">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-gray-700/50">{children}</tr>,
        th: ({ children }) => <th className="px-2 py-1.5 text-left text-gray-300 font-medium border border-gray-700">{children}</th>,
        td: ({ children }) => <td className="px-2 py-1.5 text-gray-400 border border-gray-700">{children}</td>,
        hr: () => <hr className="border-gray-700 my-3" />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

interface HistoryEntry {
  id: string;
  timestamp: string;
  question: string;
  answer: string;
  tools: string[];
  tokens: { input: number; output: number };
  responseTime: number;
}

export default function AIAssistant() {
  const { locale } = useI18n();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [toolStatus, setToolStatus] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const recognitionRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const presets = locale === "ko" ? PRESETS_KO : PRESETS_EN;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, streamText, scrollToBottom]);

  // Load conversation history from AgentCore Memory
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/memory?limit=30");
      if (res.ok) {
        const json = await res.json();
        setHistory(json.data ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // ── Voice Input (Speech Recognition) ──
  const [pendingVoiceText, setPendingVoiceText] = useState("");

  const startListening = useCallback(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { alert(locale === "ko" ? "이 브라우저는 음성 인식을 지원하지 않습니다." : "Speech recognition not supported."); return; }

    const recognition = new SpeechRecognition();
    recognition.lang = locale === "ko" ? "ko-KR" : "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (e: any) => {
      const transcript = Array.from(e.results).map((r: any) => r[0].transcript).join("");
      setInput(transcript);
      if (e.results[e.results.length - 1].isFinal) {
        setPendingVoiceText(transcript);
        setIsListening(false);
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
  }, [locale]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);


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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
          lang: locale,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let fullText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const toolsUsed: string[] = [];
      let via = "";
      const startTime = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n").filter((l) => l.startsWith("data: "))) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.text) { fullText += data.text; setStreamText(fullText); setToolStatus(""); }
            if (data.status) {
              setToolStatus(data.status as string);
              // Track tool names
              const toolMatch = (data.status as string).match(/[🔧⚡]\s*(\w+)/);
              if (toolMatch && !toolsUsed.includes(toolMatch[1])) toolsUsed.push(toolMatch[1]);
            }
            if (data.usage) {
              inputTokens += data.usage.inputTokens ?? data.usage.input_tokens ?? 0;
              outputTokens += data.usage.outputTokens ?? data.usage.output_tokens ?? 0;
            }
            if (data.via) via = data.via as string;
          } catch { /* ignore */ }
        }
      }

      const responseTime = Date.now() - startTime;
      setMessages([...newMessages, {
        role: "assistant", content: fullText, timestamp: new Date().toISOString(),
        inputTokens, outputTokens, tools: toolsUsed, responseTime, via,
      }]);

      // Save to AgentCore Memory
      fetch("/api/ai/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: content,
          answer: fullText,
          tools: toolsUsed,
          inputTokens,
          outputTokens,
          responseTime,
        }),
      }).then(() => void loadHistory()).catch(() => {});
      setStreamText("");
    } catch (err) {
      setMessages([...newMessages, { role: "assistant", content: `❌ Error: ${err instanceof Error ? err.message : "Unknown"}`, timestamp: new Date().toISOString() }]);
      setStreamText("");
    } finally {
      setLoading(false);
    }
  };

  // Auto-send voice input when recognition completes
  useEffect(() => {
    if (pendingVoiceText && !loading) {
      void sendMessage(pendingVoiceText);
      setPendingVoiceText("");
    }
  }, [pendingVoiceText, loading, sendMessage]);

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
            <p className="text-[10px] text-gray-500">Powered by Claude Sonnet 5 on Bedrock · {locale === "ko" ? "음성 지원" : "Voice enabled"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium rounded-full bg-cyan-500/10 text-cyan-400">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Sonnet 5
          </span>
          {history.length > 0 && (
            <button onClick={() => setShowHistory(!showHistory)} className="px-2 py-1 text-[10px] text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors">
              {locale === "ko" ? "히스토리" : "History"} ({history.length})
            </button>
          )}
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
              {msg.role === "assistant" && (
                <div className="mt-3 pt-2 border-t border-gray-800/50 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {msg.tools && msg.tools.length > 0 && (
                    <span className="text-[9px] text-gray-500">
                      🔧 {msg.tools.join(", ")}
                    </span>
                  )}
                  {(msg.inputTokens || msg.outputTokens) && (
                    <span className="text-[9px] text-gray-500">
                      📊 In: {(msg.inputTokens ?? 0).toLocaleString()} · Out: {(msg.outputTokens ?? 0).toLocaleString()} tokens
                    </span>
                  )}
                  {msg.responseTime && (
                    <span className="text-[9px] text-gray-500">
                      ⏱ {(msg.responseTime / 1000).toFixed(1)}s
                    </span>
                  )}
                  {msg.via && (
                    <span className="text-[9px] text-cyan-600">
                      via {msg.via}
                    </span>
                  )}
                  <button
                    onClick={async () => {
                      await navigator.clipboard.writeText(msg.content);
                      setCopiedIdx(i);
                      setTimeout(() => setCopiedIdx(null), 2000);
                    }}
                    className="ml-auto text-[9px] text-gray-600 hover:text-gray-300 transition-colors flex items-center gap-1"
                    title={locale === "ko" ? "복사" : "Copy"}
                  >
                    {copiedIdx === i ? (
                      <><svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><span className="text-green-400">{locale === "ko" ? "복사됨" : "Copied"}</span></>
                    ) : (
                      <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg><span>{locale === "ko" ? "복사" : "Copy"}</span></>
                    )}
                  </button>
                </div>
              )}
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

      {/* Conversation History */}
      {history.length > 0 && (
        <div className="border-t border-gray-800 pt-3">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 rounded-lg transition-colors w-full"
          >
            <svg className="w-4 h-4 text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-medium">{locale === "ko" ? "대화 히스토리" : "Conversation History"}</span>
            <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded-full">{history.length}</span>
            <span className="text-[10px] text-cyan-600/60 ml-auto">AgentCore Memory</span>
            <span className="text-gray-600">{showHistory ? "▼" : "▶"}</span>
          </button>
          {showHistory && (
            <div className="mt-2 max-h-72 overflow-y-auto space-y-2 px-1">
              {history.map((h) => (
                <button
                  key={h.id}
                  onClick={() => void sendMessage(h.question as string)}
                  className="w-full text-left p-3 rounded-xl bg-[#0a0f1a] border border-gray-800/40 hover:border-cyan-500/30 hover:bg-[#0d1420] transition-all group"
                >
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <span className="text-xs text-gray-300 group-hover:text-cyan-300 line-clamp-2 leading-relaxed">
                      {h.question as string}
                    </span>
                    <span className="text-[10px] text-gray-600 shrink-0 mt-0.5">
                      {h.timestamp ? new Date(h.timestamp as string).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                    </span>
                  </div>
                  {(h.answer as string) && (
                    <p className="text-[10px] text-gray-600 truncate mb-1.5">{h.answer as string}</p>
                  )}
                  <div className="flex items-center gap-3 text-[10px]">
                    {(h.tools as string[])?.length > 0 && (
                      <span className="text-cyan-600">🔧 {(h.tools as string[]).length} tools</span>
                    )}
                    {h.tokens && (
                      <span className="text-purple-600">📊 {((h.tokens as {input:number;output:number}).input + (h.tokens as {input:number;output:number}).output).toLocaleString()} tok</span>
                    )}
                    {h.responseTime && (
                      <span className="text-amber-600">⏱ {((h.responseTime as number) / 1000).toFixed(1)}s</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <div className="pt-3 border-t border-gray-800 space-y-2">
        {/* Voice status */}
        {isListening && (
          <div className="flex items-center gap-2 px-1">
            <span className="flex items-center gap-1 text-[10px] text-red-400 animate-pulse">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              {locale === "ko" ? "듣고 있습니다..." : "Listening..."}
            </span>
          </div>
        )}

        {/* Input row */}
        <div className="flex gap-2">
          {/* Mic button */}
          <button
            onClick={isListening ? stopListening : startListening}
            disabled={loading}
            className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
              isListening
                ? "bg-red-600 text-white animate-pulse shadow-lg shadow-red-600/20"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            } disabled:opacity-40`}
            title={locale === "ko" ? "음성으로 질문하기" : "Ask by voice"}
          >
            {isListening ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            )}
          </button>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={locale === "ko" ? "질문을 입력하거나 🎤 마이크를 누르세요..." : "Type or press 🎤 to speak..."}
            rows={1}
            className="flex-1 px-4 py-2.5 text-sm bg-[#111827] border border-gray-800 text-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-transparent placeholder-gray-600 resize-none"
            disabled={loading}
          />

          {/* Send button */}
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
