"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import type { SpendLog, ContainerInfo, ModelMetrics, ApiResponse } from "@/lib/types";
import type { KeySpendInfo } from "@/lib/litellm-client";

interface HomeDashboardProps {
  isAdmin: boolean;
}

interface SystemHealth {
  status: string;
  db: string;
  cache: string;
  litellm_version: string;
  model_count: number;
}

interface ContainerCWMetrics {
  cpuUtilized: number;
  cpuReserved: number;
  cpuUtilizationPct: number;
  memoryUtilized: number;
  memoryReserved: number;
  memoryUtilizationPct: number;
  networkRxBytes: number;
  networkTxBytes: number;
  taskCount: number;
  containerInstanceCount: number;
}

// ── Helpers ──
function formatCost(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(2)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}
function formatNum(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(v < 10 && v > 0 ? 2 : 0);
}
function formatBytes(b: number): string {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

// ── Section Header ──
function SectionHeader({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.15em]">{children}</h2>
      {right}
    </div>
  );
}

// ── Hero Stat Card (large, gradient, icon) ──
function HeroCard({ title, value, subtitle, icon, gradient }: {
  title: string; value: string; subtitle?: string; icon: React.ReactNode; gradient: string;
}) {
  return (
    <div className={`relative overflow-hidden rounded-xl border border-gray-800/50 p-5 bg-gradient-to-br ${gradient} hover:scale-[1.01] transition-transform`}>
      <div className="relative z-10">
        <p className="text-[10px] text-gray-300/80 uppercase tracking-wider font-medium">{title}</p>
        <p className="mt-1.5 text-3xl font-extrabold text-white tracking-tight">{value}</p>
        {subtitle && <p className="mt-1 text-[11px] text-gray-300/60">{subtitle}</p>}
      </div>
      <div className="absolute top-4 right-4 opacity-20 text-white">{icon}</div>
    </div>
  );
}

// ── Compact Stat ──
function CompactStat({ label, value, sub, color = "text-white" }: {
  label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="bg-[#111827] rounded-lg border border-gray-800/50 p-3.5">
      <p className="text-[10px] text-gray-500 truncate">{label}</p>
      <p className={`text-lg font-bold ${color} mt-0.5`}>{value}</p>
      {sub && <p className="text-[9px] text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Mini Progress Bar ──
function MiniBar({ pct, color, label, detail }: {
  pct: number; color: string; label: string; detail: string;
}) {
  const barColor = pct > 80 ? "bg-red-500" : pct > 60 ? "bg-yellow-500" : color;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px]">
        <span className="text-gray-400">{label}</span>
        <span className="text-gray-500">{detail}</span>
      </div>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

// ── Status Dot ──
function StatusDot({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={`w-2 h-2 rounded-full shrink-0 ${ok ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
      <span className="text-[11px] text-gray-400 flex-1">{label}</span>
      <span className={`text-[11px] font-medium ${ok ? "text-green-400" : "text-red-400"}`}>{value}</span>
    </div>
  );
}

// ── Quick Nav ──
function NavCard({ href, title, desc, icon, accent }: {
  href: string; title: string; desc: string; icon: React.ReactNode; accent: string;
}) {
  return (
    <Link href={href} className="flex items-center gap-3 p-3.5 bg-[#111827] rounded-lg border border-gray-800/50 hover:border-gray-600 hover:bg-[#151d2e] transition-all group">
      <div className={`p-2 rounded-lg ${accent} shrink-0`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-200 group-hover:text-white">{title}</p>
        <p className="text-[10px] text-gray-500 truncate">{desc}</p>
      </div>
      <svg className="w-3.5 h-3.5 text-gray-700 group-hover:text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  );
}

// ── SVG Icons (larger for hero) ──
function DollarIcon({ size = 5 }: { size?: number }) {
  return <svg className={`w-${size} h-${size}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
}
function BoltIcon({ size = 5 }: { size?: number }) {
  return <svg className={`w-${size} h-${size}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>;
}
function UsersIcon({ size = 5 }: { size?: number }) {
  return <svg className={`w-${size} h-${size}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>;
}
function ServerIcon({ size = 5 }: { size?: number }) {
  return <svg className={`w-${size} h-${size}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" /></svg>;
}
function ChartIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>;
}

export default function HomeDashboard({ isAdmin }: HomeDashboardProps) {
  const { t } = useI18n();
  const [logs, setLogs] = useState<SpendLog[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [keySpendList, setKeySpendList] = useState<KeySpendInfo[]>([]);
  const [modelMetrics, setModelMetrics] = useState<ModelMetrics[]>([]);
  const [cwMetrics, setCwMetrics] = useState<ContainerCWMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

      const [logsRes, containersRes] = await Promise.all([
        fetch(`/api/litellm?action=spend_logs&start_date=${weekAgo}&end_date=${tomorrow}`),
        fetch("/api/containers"),
      ]);
      const logsJson = (await logsRes.json()) as ApiResponse<SpendLog[]>;
      setLogs(logsJson.data ?? []);
      const cJson = (await containersRes.json()) as ApiResponse<ContainerInfo[]>;
      setContainers(cJson.data ?? []);

      if (isAdmin) {
        try {
          const [healthRes, keyRes, metricsRes, cwRes] = await Promise.all([
            fetch("/api/litellm?action=system_health"),
            fetch("/api/litellm?action=key_spend_list"),
            fetch(`/api/litellm?action=model_metrics&start_date=${weekAgo}&end_date=${tomorrow}`),
            fetch("/api/container-metrics?action=current"),
          ]);
          if (healthRes.ok) { const j = (await healthRes.json()) as ApiResponse<SystemHealth>; setSystemHealth(j.data ?? null); }
          if (keyRes.ok) { const j = (await keyRes.json()) as ApiResponse<KeySpendInfo[]>; setKeySpendList(j.data ?? []); }
          if (metricsRes.ok) { const j = (await metricsRes.json()) as ApiResponse<ModelMetrics[]>; setModelMetrics(j.data ?? []); }
          if (cwRes.ok) { const j = (await cwRes.json()) as ApiResponse<ContainerCWMetrics>; setCwMetrics(j.data ?? null); }
        } catch (e) { console.error("Admin fetch error:", e); }
      }
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Home fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Computed
  const totalSpend = logs.reduce((s, l) => s + l.spend, 0);
  const totalRequests = logs.length;
  const totalTokens = logs.reduce((s, l) => s + l.total_tokens, 0);
  const totalInput = logs.reduce((s, l) => s + l.prompt_tokens, 0);
  const totalOutput = logs.reduce((s, l) => s + l.completion_tokens, 0);
  const activeUsers = new Set(logs.map((l) => l.user || l.api_key)).size;
  const runningContainers = containers.filter((c) => c.status === "RUNNING");
  const dailyBurn = totalSpend / 7;
  const monthlyEst = dailyBurn * 30;
  const avgCostPerReq = totalRequests > 0 ? totalSpend / totalRequests : 0;
  const avgTokensPerReq = totalRequests > 0 ? totalTokens / totalRequests : 0;
  const outputRatio = totalTokens > 0 ? (totalOutput / totalTokens) * 100 : 0;

  // Budget
  const totalBudget = keySpendList.reduce((s, k) => s + (k.max_budget ?? 0), 0);
  const totalKeySpend = keySpendList.reduce((s, k) => s + k.spend, 0);
  const budgetPct = totalBudget > 0 ? (totalKeySpend / totalBudget) * 100 : 0;

  // Top model
  const topModel = [...modelMetrics].sort((a, b) => b.num_requests - a.num_requests)[0];
  const avgLatency = modelMetrics.length > 0
    ? modelMetrics.reduce((s, m) => s + m.avg_latency_seconds * 1000, 0) / modelMetrics.length : 0;

  const isOnline = systemHealth?.status === "healthy";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">CC-on-Bedrock Dashboard</h1>
          <p className="text-[11px] text-gray-500">{t("home.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-[10px] text-gray-600">Updated {lastUpdated.toLocaleTimeString()}</span>}
          <button onClick={() => void fetchData()} className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors" title="Refresh">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          </button>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold rounded-full ${isOnline ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            {isOnline ? "ONLINE" : "OFFLINE"}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48"><div className="text-sm text-gray-500">Loading...</div></div>
      ) : (
        <>
          {/* ── HERO CARDS ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <HeroCard title={t("home.totalCost")} value={formatCost(totalSpend)} subtitle={`Daily avg: ${formatCost(dailyBurn)}`}
              icon={<DollarIcon size={12} />} gradient="from-blue-900/40 to-blue-950/20" />
            <HeroCard title={t("home.totalRequests")} value={formatNum(totalRequests)} subtitle={`${formatNum(totalTokens)} tokens`}
              icon={<BoltIcon size={12} />} gradient="from-purple-900/40 to-purple-950/20" />
            <HeroCard title={t("home.activeUsers")} value={String(activeUsers)} subtitle={`${keySpendList.length} API keys`}
              icon={<UsersIcon size={12} />} gradient="from-green-900/40 to-green-950/20" />
            <HeroCard title={t("home.runningContainers")} value={`${runningContainers.length}`} subtitle={`${containers.length} total · ${cwMetrics?.containerInstanceCount ?? "?"} hosts`}
              icon={<ServerIcon size={12} />} gradient="from-amber-900/40 to-amber-950/20" />
          </div>

          {/* ── COST & TOKEN INSIGHTS ── */}
          <div>
            <SectionHeader>COST &amp; TOKEN INSIGHTS</SectionHeader>
            <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
              <CompactStat label="Monthly Est." value={formatCost(monthlyEst)} sub="Projected 30d" color="text-red-400" />
              <CompactStat label="Avg Cost/Req" value={`$${avgCostPerReq.toFixed(6)}`} sub="Unit price" />
              <CompactStat label="Avg Tokens/Req" value={formatNum(avgTokensPerReq)} sub="In + Out" />
              <CompactStat label="Input Tokens" value={formatNum(totalInput)} sub={`${(100 - outputRatio).toFixed(0)}% of total`} color="text-blue-400" />
              <CompactStat label="Output Tokens" value={formatNum(totalOutput)} sub={`${outputRatio.toFixed(0)}% of total`} color="text-purple-400" />
              <CompactStat label="Budget Used" value={`${budgetPct.toFixed(1)}%`} sub={`${formatCost(totalKeySpend)} / $${totalBudget.toFixed(0)}`} color={budgetPct > 80 ? "text-red-400" : "text-cyan-400"} />
            </div>
          </div>

          {/* ── MODEL & PERFORMANCE ── */}
          {isAdmin && modelMetrics.length > 0 && (
            <div>
              <SectionHeader>BEDROCK MODEL PERFORMANCE</SectionHeader>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Model breakdown */}
                <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Model Usage</p>
                  <div className="space-y-2.5">
                    {[...modelMetrics].sort((a, b) => b.num_requests - a.num_requests).slice(0, 5).map((m) => {
                      const totalReqs = modelMetrics.reduce((s, x) => s + x.num_requests, 0);
                      const pct = totalReqs > 0 ? (m.num_requests / totalReqs) * 100 : 0;
                      const name = m.model.replace("bedrock/", "").replace("global.anthropic.", "").replace("apac.anthropic.", "");
                      return (
                        <div key={m.model}>
                          <div className="flex justify-between text-[11px] mb-0.5">
                            <span className="text-gray-300 truncate mr-2">{name}</span>
                            <span className="text-gray-500 shrink-0">{m.num_requests} req · {formatCost(m.total_spend)}</span>
                          </div>
                          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Performance stats */}
                <div className="grid grid-cols-2 gap-3">
                  <CompactStat label="Top Model" value={topModel ? topModel.model.replace("bedrock/", "").replace("global.anthropic.", "").split("-").slice(0, 2).join("-") : "-"} sub={topModel ? `${topModel.num_requests} requests` : ""} color="text-cyan-400" />
                  <CompactStat label="Avg Latency" value={`${avgLatency.toFixed(0)}ms`} sub="All models" color={avgLatency > 5000 ? "text-red-400" : "text-green-400"} />
                  <CompactStat label="Models Active" value={modelMetrics.filter(m => m.num_requests > 0).length} sub={`/ ${systemHealth?.model_count ?? modelMetrics.length} configured`} />
                  <CompactStat label="LiteLLM" value={`v${systemHealth?.litellm_version ?? "?"}`} sub={`Cache: ${systemHealth?.cache ?? "?"}`} color="text-gray-300" />
                </div>
              </div>
            </div>
          )}

          {/* ── CONTAINER INSIGHTS ── */}
          {isAdmin && cwMetrics && (
            <div>
              <SectionHeader>CONTAINER INSIGHTS (ECS)</SectionHeader>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* CPU & Memory utilization */}
                <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5 space-y-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Cluster Utilization</p>
                  <MiniBar pct={cwMetrics.cpuUtilizationPct} color="bg-cyan-500" label="CPU" detail={`${cwMetrics.cpuUtilized.toFixed(0)} / ${cwMetrics.cpuReserved.toFixed(0)} units (${cwMetrics.cpuUtilizationPct.toFixed(1)}%)`} />
                  <MiniBar pct={cwMetrics.memoryUtilizationPct} color="bg-purple-500" label="Memory" detail={`${cwMetrics.memoryUtilized.toFixed(0)} / ${cwMetrics.memoryReserved.toFixed(0)} MiB (${cwMetrics.memoryUtilizationPct.toFixed(1)}%)`} />
                </div>

                {/* Network & Storage */}
                <div className="grid grid-cols-2 gap-3">
                  <CompactStat label="Network Rx" value={formatBytes(cwMetrics.networkRxBytes)} sub="Inbound" color="text-cyan-400" />
                  <CompactStat label="Network Tx" value={formatBytes(cwMetrics.networkTxBytes)} sub="Outbound" color="text-amber-400" />
                  <CompactStat label="Tasks" value={cwMetrics.taskCount} sub={`${cwMetrics.containerInstanceCount} hosts`} />
                  <CompactStat label="CPU %" value={`${cwMetrics.cpuUtilizationPct.toFixed(1)}%`} color={cwMetrics.cpuUtilizationPct > 80 ? "text-red-400" : cwMetrics.cpuUtilizationPct > 60 ? "text-yellow-400" : "text-green-400"} sub="Cluster avg" />
                </div>

                {/* Container distribution */}
                <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Container Mix</p>
                  {(() => {
                    const os: Record<string, number> = {};
                    const tier: Record<string, number> = {};
                    for (const c of runningContainers) {
                      os[c.containerOs] = (os[c.containerOs] ?? 0) + 1;
                      tier[c.resourceTier] = (tier[c.resourceTier] ?? 0) + 1;
                    }
                    const total = runningContainers.length || 1;
                    return (
                      <div className="space-y-2">
                        {Object.entries(os).map(([k, v]) => (
                          <MiniBar key={k} pct={(v / total) * 100} color="bg-blue-500" label={k === "al2023" ? "AL2023" : "Ubuntu"} detail={`${v} (${((v / total) * 100).toFixed(0)}%)`} />
                        ))}
                        <div className="border-t border-gray-800 pt-2 mt-2" />
                        {Object.entries(tier).map(([k, v]) => {
                          const c = k === "light" ? "bg-gray-500" : k === "standard" ? "bg-blue-500" : "bg-purple-500";
                          return <MiniBar key={k} pct={(v / total) * 100} color={c} label={k} detail={`${v}`} />;
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* ── SYSTEM STATUS & API KEYS ── */}
          {isAdmin && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* System status */}
              {systemHealth && (
                <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">System Status</p>
                  <StatusDot ok={systemHealth.status === "healthy"} label="LiteLLM Proxy" value={systemHealth.status} />
                  <StatusDot ok={systemHealth.db === "connected"} label="Database (PostgreSQL)" value={systemHealth.db} />
                  <StatusDot ok={systemHealth.cache === "redis"} label="Cache (Valkey)" value={systemHealth.cache} />
                  <StatusDot ok={true} label="Bedrock Models" value={`${systemHealth.model_count} configured`} />
                  <StatusDot ok={runningContainers.length > 0} label="ECS Containers" value={`${runningContainers.length} running`} />
                </div>
              )}

              {/* API Key budget summary */}
              {keySpendList.length > 0 && (
                <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">API Key Budget</p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {[...keySpendList].filter(k => k.key_alias).sort((a, b) => b.spend - a.spend).slice(0, 8).map((k) => {
                      const pct = k.max_budget ? (k.spend / k.max_budget) * 100 : 0;
                      return (
                        <MiniBar key={k.key_name} pct={pct} color="bg-blue-500" label={k.key_alias || k.key_name} detail={`${formatCost(k.spend)} / $${k.max_budget ?? "∞"}`} />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── QUICK ACTIONS ── */}
          {isAdmin && (
            <div>
              <SectionHeader>QUICK ACTIONS</SectionHeader>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                <NavCard href="/analytics" title={t("home.viewAnalytics")} desc="Cost, tokens, leaderboard" icon={<span className="text-cyan-400"><ChartIcon /></span>} accent="bg-cyan-500/10" />
                <NavCard href="/monitoring" title={t("home.viewMonitoring")} desc="Health, insights, sessions" icon={<span className="text-green-400"><BoltIcon /></span>} accent="bg-green-500/10" />
                <NavCard href="/admin" title={t("home.manageUsers")} desc={`${activeUsers} active users`} icon={<span className="text-purple-400"><UsersIcon /></span>} accent="bg-purple-500/10" />
                <NavCard href="/admin/containers" title={t("home.manageContainers")} desc={`${runningContainers.length} running`} icon={<span className="text-amber-400"><ServerIcon /></span>} accent="bg-amber-500/10" />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
