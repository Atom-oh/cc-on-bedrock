"use client";

import { useState, useEffect, useCallback } from "react";
import LeaderboardChart from "@/components/charts/leaderboard-chart";
import AreaTrendChart from "@/components/charts/area-trend-chart";
import MultiLineChart from "@/components/charts/multi-line-chart";
import HorizontalBarChart from "@/components/charts/horizontal-bar-chart";
import type {
  SpendLog,
  ModelMetrics,
  ApiResponse,
} from "@/lib/types";
import type { KeySpendInfo } from "@/lib/litellm-client";

interface AnalyticsDashboardProps {
  isAdmin: boolean;
}

interface SystemHealth {
  status: string;
  db: string;
  cache: string;
  litellm_version: string;
  model_count: number;
}

type TimeRange = "1d" | "7d" | "30d";

function getDateRange(range: TimeRange): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  switch (range) {
    case "1d":
      start.setDate(end.getDate() - 1);
      break;
    case "7d":
      start.setDate(end.getDate() - 7);
      break;
    case "30d":
      start.setDate(end.getDate() - 30);
      break;
  }
  return {
    start: start.toISOString().split("T")[0],
    end: end.toISOString().split("T")[0],
  };
}

function formatNumber(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(v < 10 ? 2 : 0);
}

function formatCost(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(2)}K`;
  return `$${v.toFixed(4)}`;
}

function maskName(email: string): string {
  const local = email.split("@")[0] ?? email;
  if (local.length <= 2) return local + "*";
  return local.slice(0, 2) + "*".repeat(Math.min(local.length - 2, 3));
}

// Collapsible section
function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm font-semibold text-gray-300 mb-3 hover:text-white transition-colors"
      >
        <span className="text-xs">{open ? "▼" : "▶"}</span>
        {title}
      </button>
      {open && children}
    </div>
  );
}

// Overview stat card (dark theme)
function DarkStatCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-700 p-5">
      <p className="text-xs font-medium text-gray-400 mb-1">{title}</p>
      <p className="text-3xl font-bold text-white tracking-tight">{value}</p>
      {subtitle && (
        <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
      )}
    </div>
  );
}

// --- Aggregation helpers ---

interface UserAgg {
  email: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  spend: number;
  requests: number;
}

interface DateAgg {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  requests: number;
  spend: number;
  [key: string]: string | number;
}

function aggregateByUser(logs: SpendLog[]): UserAgg[] {
  const map = new Map<string, UserAgg>();
  for (const log of logs) {
    const key = log.user || log.api_key?.slice(-8) || "unknown";
    const existing = map.get(key) ?? {
      email: key,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      spend: 0,
      requests: 0,
    };
    existing.totalTokens += log.total_tokens;
    existing.inputTokens += log.prompt_tokens;
    existing.outputTokens += log.completion_tokens;
    existing.spend += log.spend;
    existing.requests += 1;
    map.set(key, existing);
  }
  return Array.from(map.values());
}

function aggregateByDate(logs: SpendLog[]): DateAgg[] {
  const map = new Map<string, DateAgg>();
  for (const log of logs) {
    const date = log.startTime?.split("T")[0] ?? "unknown";
    const existing = map.get(date) ?? {
      date,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      requests: 0,
      spend: 0,
    };
    existing.inputTokens += log.prompt_tokens;
    existing.outputTokens += log.completion_tokens;
    existing.requests += 1;
    existing.spend += log.spend;
    map.set(date, existing);
  }
  return Array.from(map.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

function aggregateByDateAndUser(
  logs: SpendLog[],
  topUsers: string[]
): DateAgg[] {
  const map = new Map<string, DateAgg>();
  for (const log of logs) {
    const date = log.startTime?.split("T")[0] ?? "unknown";
    const user = log.user || log.api_key?.slice(-8) || "unknown";
    const existing = map.get(date) ?? ({
      date,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      requests: 0,
      spend: 0,
    } as DateAgg);
    if (topUsers.includes(user)) {
      existing[user] = ((existing[user] as number) ?? 0) + log.total_tokens;
    }
    map.set(date, existing);
  }
  return Array.from(map.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

const USER_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export default function AnalyticsDashboard({
  isAdmin,
}: AnalyticsDashboardProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1d");
  const [logs, setLogs] = useState<SpendLog[]>([]);
  const [modelMetrics, setModelMetrics] = useState<ModelMetrics[]>([]);
  const [keySpendList, setKeySpendList] = useState<KeySpendInfo[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const { start, end } = getDateRange(timeRange);

    try {
      const fetches: Promise<Response | null>[] = [
        fetch(`/api/litellm?action=spend_logs&start_date=${start}&end_date=${end}`),
      ];

      if (isAdmin) {
        fetches.push(
          fetch(`/api/litellm?action=model_metrics&start_date=${start}&end_date=${end}`),
          fetch("/api/litellm?action=key_spend_list"),
          fetch("/api/litellm?action=system_health"),
        );
      }

      const [logsRes, metricsRes, keyRes, healthRes] = await Promise.all(fetches);

      const logsJson = (await logsRes!.json()) as ApiResponse<SpendLog[]>;
      setLogs(logsJson.data ?? []);

      if (metricsRes) {
        const metricsJson = (await metricsRes.json()) as ApiResponse<ModelMetrics[]>;
        setModelMetrics(metricsJson.data ?? []);
      }
      if (keyRes) {
        const keyJson = (await keyRes.json()) as ApiResponse<KeySpendInfo[]>;
        setKeySpendList(keyJson.data ?? []);
      }
      if (healthRes) {
        const healthJson = (await healthRes.json()) as ApiResponse<SystemHealth>;
        setSystemHealth(healthJson.data ?? null);
      }

      setLastUpdated(new Date());
    } catch (err) {
      console.error("Failed to fetch analytics data:", err);
    } finally {
      setLoading(false);
    }
  }, [timeRange, isAdmin]);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Computed data
  const userAggs = aggregateByUser(logs);
  const dateAggs = aggregateByDate(logs);
  const totalSpend = logs.reduce((s, l) => s + l.spend, 0);
  const totalRequests = logs.length;
  const activeUsers = new Set(logs.map((l) => l.user || l.api_key)).size;
  const avgLatency =
    modelMetrics.length > 0
      ? modelMetrics.reduce((s, m) => s + m.avg_latency_seconds * 1000, 0) /
        modelMetrics.length
      : 0;

  // Leaderboard data
  const byTotal = [...userAggs]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((u) => ({ name: maskName(u.email), value: u.totalTokens }));
  const byInput = [...userAggs]
    .sort((a, b) => b.inputTokens - a.inputTokens)
    .map((u) => ({ name: maskName(u.email), value: u.inputTokens }));
  const byOutput = [...userAggs]
    .sort((a, b) => b.outputTokens - a.outputTokens)
    .map((u) => ({ name: maskName(u.email), value: u.outputTokens }));

  // Top users for multi-line chart
  const top5Users = [...userAggs]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 5)
    .map((u) => u.email);
  const userTrendData = aggregateByDateAndUser(logs, top5Users);
  const userTrendSeries = top5Users.map((u, i) => ({
    key: u,
    name: maskName(u),
    color: USER_COLORS[i % USER_COLORS.length],
  }));

  // Model cost data
  const modelCostData = [...modelMetrics]
    .sort((a, b) => b.total_spend - a.total_spend)
    .map((m) => ({
      name: m.model.replace("bedrock/", "").replace("global.", ""),
      value: m.total_spend,
    }));

  // User session (requests) data
  const userSessionData = [...userAggs]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 10)
    .map((u) => ({ name: maskName(u.email), value: u.requests }));

  // Model latency data
  const modelLatencyData = [...modelMetrics]
    .sort((a, b) => b.avg_latency_seconds - a.avg_latency_seconds)
    .map((m) => ({
      name: m.model.replace("bedrock/", "").replace("global.", ""),
      value: Math.round(m.avg_latency_seconds * 1000),
    }));

  // User cost TOP 10
  const userCostData = [...userAggs]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10)
    .map((u) => ({ name: maskName(u.email), value: u.spend }));

  // --- Insights ---
  const totalTokens = logs.reduce((s, l) => s + l.total_tokens, 0);
  const totalInputTokens = logs.reduce((s, l) => s + l.prompt_tokens, 0);
  const totalOutputTokens = logs.reduce((s, l) => s + l.completion_tokens, 0);
  const outputRatio = totalTokens > 0 ? (totalOutputTokens / totalTokens) * 100 : 0;
  const avgTokensPerReq = totalRequests > 0 ? totalTokens / totalRequests : 0;
  const avgCostPerReq = totalRequests > 0 ? totalSpend / totalRequests : 0;

  // Cost projection
  const daysInRange = timeRange === "1d" ? 1 : timeRange === "7d" ? 7 : 30;
  const dailyBurnRate = daysInRange > 0 ? totalSpend / daysInRange : 0;
  const projectedMonthly = dailyBurnRate * 30;

  // Key budget data
  const keyBudgetData = keySpendList
    .filter((k) => k.key_alias)
    .sort((a, b) => b.spend - a.spend);
  const totalBudget = keyBudgetData.reduce((s, k) => s + (k.max_budget ?? 0), 0);
  const totalKeySpend = keyBudgetData.reduce((s, k) => s + k.spend, 0);
  const budgetUtilization = totalBudget > 0 ? (totalKeySpend / totalBudget) * 100 : 0;

  // Model distribution for donut
  const modelRequestData = [...modelMetrics]
    .filter((m) => m.num_requests > 0)
    .sort((a, b) => b.num_requests - a.num_requests)
    .map((m) => ({
      name: m.model.replace("bedrock/", "").replace("global.anthropic.", "").replace("apac.anthropic.", ""),
      requests: m.num_requests,
      tokens: m.total_tokens,
      spend: m.total_spend,
      latency: Math.round(m.avg_latency_seconds * 1000),
    }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Claude Code Usage</h2>
          <p className="text-xs text-gray-500">
            {lastUpdated
              ? `Last updated: ${lastUpdated.toLocaleTimeString()}`
              : "Loading..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(["1d", "7d", "30d"] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                timeRange === range
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
            >
              {range === "1d"
                ? "Past 1 Day"
                : range === "7d"
                ? "Past 7 Days"
                : "Past 30 Days"}
            </button>
          ))}
          <button
            onClick={() => void fetchData()}
            className="px-3 py-1.5 text-xs font-medium rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {loading && logs.length === 0 ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-sm text-gray-500">Loading analytics...</div>
        </div>
      ) : (
        <>
          {/* Section 1: Overview */}
          <Section title="Overview">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <DarkStatCard
                title="총 비용 (USD)"
                value={formatCost(totalSpend)}
              />
              <DarkStatCard
                title="총 API 요청 수"
                value={formatNumber(totalRequests)}
              />
              <DarkStatCard
                title="활성 사용자 수"
                value={String(activeUsers)}
              />
              <DarkStatCard
                title="평균 응답시간 (ms)"
                value={formatNumber(avgLatency)}
              />
            </div>
          </Section>

          {/* Section: Insights */}
          {isAdmin && (
            <Section title="Insights & 비용 분석">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <DarkStatCard
                  title="일일 Burn Rate"
                  value={formatCost(dailyBurnRate)}
                  subtitle="현재 기간 일평균"
                />
                <DarkStatCard
                  title="월간 비용 예측"
                  value={formatCost(projectedMonthly)}
                  subtitle="현재 속도 기준"
                />
                <DarkStatCard
                  title="요청당 평균 비용"
                  value={`$${avgCostPerReq.toFixed(6)}`}
                  subtitle="API 호출 단가"
                />
                <DarkStatCard
                  title="요청당 평균 토큰"
                  value={formatNumber(avgTokensPerReq)}
                  subtitle="Input + Output"
                />
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <DarkStatCard
                  title="총 Input 토큰"
                  value={formatNumber(totalInputTokens)}
                  subtitle={`${(100 - outputRatio).toFixed(1)}% of total`}
                />
                <DarkStatCard
                  title="총 Output 토큰"
                  value={formatNumber(totalOutputTokens)}
                  subtitle={`${outputRatio.toFixed(1)}% of total`}
                />
                <DarkStatCard
                  title="예산 사용률"
                  value={`${budgetUtilization.toFixed(1)}%`}
                  subtitle={`$${totalKeySpend.toFixed(4)} / $${totalBudget.toFixed(0)}`}
                />
                <DarkStatCard
                  title="등록 모델 수"
                  value={String(systemHealth?.model_count ?? modelMetrics.length)}
                  subtitle={systemHealth?.litellm_version ? `LiteLLM v${systemHealth.litellm_version}` : ""}
                />
              </div>
            </Section>
          )}

          {/* Section: System Health */}
          {isAdmin && systemHealth && (
            <Section title="시스템 상태" defaultOpen={false}>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Proxy Status</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${systemHealth.status === "healthy" ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.status}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Database</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${systemHealth.db === "connected" ? "bg-green-400" : "bg-red-400"}`} />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.db}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Cache (Valkey)</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${systemHealth.cache === "redis" ? "bg-green-400" : "bg-yellow-400"}`} />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.cache}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">LiteLLM Version</p>
                  <span className="text-sm font-medium text-gray-200">v{systemHealth.litellm_version}</span>
                </div>
              </div>
            </Section>
          )}

          {/* Section: API Key Budget */}
          {isAdmin && keyBudgetData.length > 0 && (
            <Section title="API Key 예산 관리" defaultOpen={false}>
              <div className="bg-[#161b22] rounded-lg border border-gray-800 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-800 bg-[#0d1117]">
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">Key Alias</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">사용량</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">한도</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">사용률</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">마지막 활동</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {keyBudgetData.map((key) => {
                      const pct = key.max_budget ? (key.spend / key.max_budget) * 100 : 0;
                      const barColor = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-yellow-500" : "bg-blue-500";
                      return (
                        <tr key={key.key_name} className="hover:bg-gray-800/30 transition-colors">
                          <td className="px-4 py-2.5 text-sm text-gray-200">{key.key_alias || key.key_name}</td>
                          <td className="px-4 py-2.5 text-sm text-gray-400">${key.spend.toFixed(4)}</td>
                          <td className="px-4 py-2.5 text-sm text-gray-400">{key.max_budget ? `$${key.max_budget}` : "∞"}</td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden max-w-[100px]">
                                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                              </div>
                              <span className="text-[10px] text-gray-500 w-10">{pct.toFixed(1)}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-[10px] text-gray-500">
                            {key.last_active ? new Date(key.last_active).toLocaleString() : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* Section: Bedrock Model Details */}
          {isAdmin && modelRequestData.length > 0 && (
            <Section title="Bedrock 모델 상세">
              <div className="bg-[#161b22] rounded-lg border border-gray-800 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-800 bg-[#0d1117]">
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">Model</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">Requests</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">Total Tokens</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">Spend (USD)</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">Avg Latency</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">비율</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {modelRequestData.map((m) => {
                      const totalReqs = modelRequestData.reduce((s, x) => s + x.requests, 0);
                      const pct = totalReqs > 0 ? (m.requests / totalReqs) * 100 : 0;
                      return (
                        <tr key={m.name} className="hover:bg-gray-800/30 transition-colors">
                          <td className="px-4 py-2.5">
                            <span className="text-sm font-medium text-gray-200">{m.name}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right text-sm text-gray-400">{m.requests.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-sm text-gray-400">{formatNumber(m.tokens)}</td>
                          <td className="px-4 py-2.5 text-right text-sm text-gray-400">${m.spend.toFixed(4)}</td>
                          <td className="px-4 py-2.5 text-right text-sm text-gray-400">{m.latency}ms</td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden max-w-[80px]">
                                <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-[10px] text-gray-500 w-10">{pct.toFixed(0)}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* Section 2: Leaderboard */}
          {isAdmin && userAggs.length > 0 && (
            <Section title="Leaderboard - 토큰 사용량 TOP">
              <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <LeaderboardChart
                    data={byTotal}
                    title="총 토큰 사용량 TOP 10"
                    color="#3b82f6"
                  />
                  <LeaderboardChart
                    data={byInput}
                    title="Input 토큰 TOP 10"
                    color="#3b82f6"
                  />
                  <LeaderboardChart
                    data={byOutput}
                    title="Output 토큰 TOP 10"
                    color="#3b82f6"
                  />
                </div>
              </div>
            </Section>
          )}

          {/* Section 3: Token Usage Trends */}
          <Section title="토큰 사용량 (추이)">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <AreaTrendChart
                data={dateAggs}
                series={[
                  {
                    key: "inputTokens",
                    name: "Input Tokens",
                    color: "#3b82f6",
                  },
                  {
                    key: "outputTokens",
                    name: "Output Tokens",
                    color: "#8b5cf6",
                  },
                ]}
                title="토큰 유형별 사용 추이"
              />
              {isAdmin && top5Users.length > 0 ? (
                <MultiLineChart
                  data={userTrendData}
                  series={userTrendSeries}
                  title="사용자별 토큰 추이 (TOP 5)"
                />
              ) : (
                <AreaTrendChart
                  data={dateAggs}
                  series={[
                    {
                      key: "requests",
                      name: "Requests",
                      color: "#10b981",
                    },
                  ]}
                  title="일별 요청 수 추이"
                />
              )}
            </div>
          </Section>

          {/* Section 4: Usage Patterns */}
          <Section title="사용 패턴">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <HorizontalBarChart
                data={userSessionData}
                title="사용자별 API 요청 수"
                color="#3b82f6"
              />
              {isAdmin && modelCostData.length > 0 ? (
                <HorizontalBarChart
                  data={modelCostData}
                  title="모델별 비용 (USD)"
                  color="#3b82f6"
                  valueFormatter={(v) => `$${v.toFixed(2)}`}
                />
              ) : (
                <HorizontalBarChart
                  data={dateAggs
                    .slice(-7)
                    .map((d) => ({
                      name: d.date,
                      value: d.spend,
                    }))}
                  title="일별 비용 (USD)"
                  color="#10b981"
                  valueFormatter={(v) => `$${v.toFixed(4)}`}
                />
              )}
            </div>
          </Section>

          {/* Section 5: Model Performance */}
          {isAdmin && modelMetrics.length > 0 && (
            <Section title="모델 성능">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <HorizontalBarChart
                  data={modelLatencyData}
                  title="모델별 평균 응답시간 (ms)"
                  color="#f59e0b"
                  valueFormatter={(v) => `${v}ms`}
                />
                <HorizontalBarChart
                  data={userCostData}
                  title="사용자별 비용 TOP 10 (USD)"
                  color="#ef4444"
                  valueFormatter={(v) => `$${v.toFixed(4)}`}
                />
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
