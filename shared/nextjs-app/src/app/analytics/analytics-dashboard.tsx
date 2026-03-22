"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
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
  end.setDate(end.getDate() + 1); // include today's data
  const start = new Date();
  switch (range) {
    case "1d":
      start.setDate(start.getDate() - 1);
      break;
    case "7d":
      start.setDate(start.getDate() - 7);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
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

function maskName(name: string): string {
  // If it's a resolved alias (admin01, test01, etc.), show as-is
  if (/^(admin|test|user)\d+$/i.test(name)) return name;
  // Email: mask
  const local = name.split("@")[0] ?? name;
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

// Build token_hash_tail → user_alias map from keySpendList
function buildKeyAliasMap(keys: KeySpendInfo[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const k of keys) {
    const tokenTail = (k.token ?? "").slice(-8);
    const alias = (k.metadata as Record<string, string>)?.user
      ?? k.key_alias?.replace("-key", "")
      ?? k.key_name ?? "";
    if (tokenTail) map.set(tokenTail, alias);
  }
  return map;
}

function aggregateByUser(logs: SpendLog[], aliasMap?: Map<string, string>): UserAgg[] {
  const map = new Map<string, UserAgg>();
  for (const log of logs) {
    const rawKey = log.user || log.api_key?.slice(-8) || "unknown";
    const key = (rawKey && aliasMap?.get(rawKey)) ?? rawKey;
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
  topUsers: string[],
  aliasMap?: Map<string, string>
): DateAgg[] {
  const map = new Map<string, DateAgg>();
  for (const log of logs) {
    const date = log.startTime?.split("T")[0] ?? "unknown";
    const rawUser = log.user || log.api_key?.slice(-8) || "unknown";
    const user = (rawUser && aliasMap?.get(rawUser)) ?? rawUser;
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
  const { t } = useI18n();
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
  const keyAlias = buildKeyAliasMap(keySpendList);
  const userAggs = aggregateByUser(logs, keyAlias);
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
  const userTrendData = aggregateByDateAndUser(logs, top5Users, keyAlias);
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

  // --- User × Model cross analysis ---
  interface UserModelAgg {
    user: string;
    model: string;
    requests: number;
    tokens: number;
    spend: number;
  }
  const userModelMap = new Map<string, UserModelAgg>();
  for (const log of logs) {
    const rawUser = log.user || log.api_key?.slice(-8) || "unknown";
    const user = (rawUser && keyAlias.get(rawUser)) ?? rawUser;
    const model = (log.model ?? "unknown").replace("bedrock/", "").replace("global.anthropic.", "").replace("apac.anthropic.", "");
    const key = `${user}::${model}`;
    const existing = userModelMap.get(key) ?? { user, model, requests: 0, tokens: 0, spend: 0 };
    existing.requests += 1;
    existing.tokens += log.total_tokens ?? 0;
    existing.spend += log.spend ?? 0;
    userModelMap.set(key, existing);
  }
  const userModelAggs = Array.from(userModelMap.values());

  // All unique models used
  const allModels = [...new Set(userModelAggs.map((a) => a.model))].sort();

  // Per-user summary with primary model
  const userSummaries = userAggs.map((u) => {
    const userModels = userModelAggs.filter((a) => a.user === u.email);
    const primary = userModels.sort((a, b) => b.requests - a.requests)[0];
    return {
      ...u,
      models: userModels,
      primaryModel: primary?.model ?? "-",
      modelCount: userModels.length,
    };
  }).sort((a, b) => b.spend - a.spend);

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
          <h2 className="text-lg font-bold text-white">{t("analytics.title")}</h2>
          <p className="text-xs text-gray-500">
            {lastUpdated
              ? `${t("analytics.lastUpdated")}: ${lastUpdated.toLocaleTimeString()}`
              : t("analytics.loading")}
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
                ? t("analytics.past1d")
                : range === "7d"
                ? t("analytics.past7d")
                : t("analytics.past30d")}
            </button>
          ))}
          <button
            onClick={() => void fetchData()}
            className="px-3 py-1.5 text-xs font-medium rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
          >
            {t("analytics.refresh")}
          </button>
        </div>
      </div>

      {loading && logs.length === 0 ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-sm text-gray-500">{t("analytics.loading")}</div>
        </div>
      ) : (
        <>
          {/* Section 1: Overview */}
          <Section title={t("overview.title")}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <DarkStatCard
                title={t("overview.totalCost")}
                value={formatCost(totalSpend)}
              />
              <DarkStatCard
                title={t("overview.totalRequests")}
                value={formatNumber(totalRequests)}
              />
              <DarkStatCard
                title={t("overview.activeUsers")}
                value={String(activeUsers)}
              />
              <DarkStatCard
                title={t("overview.avgLatency")}
                value={formatNumber(avgLatency)}
              />
            </div>
          </Section>

          {/* Section: Insights */}
          {isAdmin && (
            <Section title={t("insights.title")}>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <DarkStatCard
                  title={t("insights.dailyBurn")}
                  value={formatCost(dailyBurnRate)}
                  subtitle={t("insights.dailyBurnDesc")}
                />
                <DarkStatCard
                  title={t("insights.monthlyProjection")}
                  value={formatCost(projectedMonthly)}
                  subtitle={t("insights.monthlyProjectionDesc")}
                />
                <DarkStatCard
                  title={t("insights.avgCostPerReq")}
                  value={`$${avgCostPerReq.toFixed(6)}`}
                  subtitle={t("insights.avgCostPerReqDesc")}
                />
                <DarkStatCard
                  title={t("insights.avgTokensPerReq")}
                  value={formatNumber(avgTokensPerReq)}
                  subtitle={t("insights.avgTokensPerReqDesc")}
                />
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <DarkStatCard
                  title={t("insights.totalInput")}
                  value={formatNumber(totalInputTokens)}
                  subtitle={`${(100 - outputRatio).toFixed(1)}% of total`}
                />
                <DarkStatCard
                  title={t("insights.totalOutput")}
                  value={formatNumber(totalOutputTokens)}
                  subtitle={`${outputRatio.toFixed(1)}% of total`}
                />
                <DarkStatCard
                  title={t("insights.budgetUtil")}
                  value={`${budgetUtilization.toFixed(1)}%`}
                  subtitle={`$${totalKeySpend.toFixed(4)} / $${totalBudget.toFixed(0)}`}
                />
                <DarkStatCard
                  title={t("insights.modelCount")}
                  value={String(systemHealth?.model_count ?? modelMetrics.length)}
                  subtitle={systemHealth?.litellm_version ? `LiteLLM v${systemHealth.litellm_version}` : ""}
                />
              </div>
            </Section>
          )}

          {/* Section: System Health */}
          {isAdmin && systemHealth && (
            <Section title={t("system.title")} defaultOpen={false}>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{t("system.proxyStatus")}</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${systemHealth.status === "healthy" ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.status}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{t("system.database")}</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${systemHealth.db === "connected" ? "bg-green-400" : "bg-red-400"}`} />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.db}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{t("system.cache")}</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${systemHealth.cache === "redis" ? "bg-green-400" : "bg-yellow-400"}`} />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.cache}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{t("system.version")}</p>
                  <span className="text-sm font-medium text-gray-200">v{systemHealth.litellm_version}</span>
                </div>
              </div>
            </Section>
          )}

          {/* Section: API Key Budget */}
          {isAdmin && keyBudgetData.length > 0 && (
            <Section title={t("keyBudget.title")} defaultOpen={false}>
              <div className="bg-[#161b22] rounded-lg border border-gray-800 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-800 bg-[#0d1117]">
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("keyBudget.alias")}</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("keyBudget.spend")}</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("keyBudget.limit")}</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("keyBudget.usage")}</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("keyBudget.lastActive")}</th>
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
            <Section title={t("bedrockModel.title")}>
              <div className="bg-[#161b22] rounded-lg border border-gray-800 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-800 bg-[#0d1117]">
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.model")}</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.requests")}</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.tokens")}</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.spend")}</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.latency")}</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.ratio")}</th>
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
            <Section title={t("leaderboard.title")}>
              <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <LeaderboardChart
                    data={byTotal}
                    title={t("leaderboard.totalTokens")}
                    color="#3b82f6"
                  />
                  <LeaderboardChart
                    data={byInput}
                    title={t("leaderboard.inputTokens")}
                    color="#3b82f6"
                  />
                  <LeaderboardChart
                    data={byOutput}
                    title={t("leaderboard.outputTokens")}
                    color="#3b82f6"
                  />
                </div>
              </div>
            </Section>
          )}

          {/* Section 3: Token Usage Trends */}
          <Section title={t("tokenTrends.title")}>
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
                title={t("tokenTrends.byType")}
              />
              {isAdmin && top5Users.length > 0 ? (
                <MultiLineChart
                  data={userTrendData}
                  series={userTrendSeries}
                  title={t("tokenTrends.byUser")}
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
                  title={t("tokenTrends.dailyRequests")}
                />
              )}
            </div>
          </Section>

          {/* Section 4: Usage Patterns */}
          <Section title={t("usagePatterns.title")}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <HorizontalBarChart
                data={userSessionData}
                title={t("usagePatterns.userRequests")}
                color="#3b82f6"
              />
              {isAdmin && modelCostData.length > 0 ? (
                <HorizontalBarChart
                  data={modelCostData}
                  title={t("usagePatterns.modelCost")}
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
                  title={t("usagePatterns.dailyCost")}
                  color="#10b981"
                  valueFormatter={(v) => `$${v.toFixed(4)}`}
                />
              )}
            </div>
          </Section>

          {/* Section 5: Model Performance */}
          {isAdmin && modelMetrics.length > 0 && (
            <Section title={t("modelPerf.title")}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <HorizontalBarChart
                  data={modelLatencyData}
                  title={t("modelPerf.latency")}
                  color="#f59e0b"
                  valueFormatter={(v) => `${v}ms`}
                />
                <HorizontalBarChart
                  data={userCostData}
                  title={t("modelPerf.userCost")}
                  color="#ef4444"
                  valueFormatter={(v) => `$${v.toFixed(4)}`}
                />
              </div>
            </Section>
          )}

          {/* Section 6: User × Model Insights */}
          {isAdmin && userModelAggs.length > 0 && (
            <Section title={t("userModel.title")}>
              {/* User-Model Matrix Table */}
              <div className="bg-[#161b22] rounded-lg border border-gray-800 overflow-hidden mb-4">
                <div className="px-4 py-3 border-b border-gray-800">
                  <h4 className="text-xs font-medium text-gray-300">{t("userModel.matrix")}</h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-800 bg-[#0d1117]">
                        <th className="px-3 py-2 text-left text-[10px] font-medium text-gray-500 uppercase sticky left-0 bg-[#0d1117] z-10">{t("userModel.user")}</th>
                        {allModels.map((m) => (
                          <th key={m} className="px-3 py-2 text-center text-[10px] font-medium text-gray-500 uppercase whitespace-nowrap">
                            {m.split("-").slice(0, 2).join("-")}
                          </th>
                        ))}
                        <th className="px-3 py-2 text-right text-[10px] font-medium text-gray-500 uppercase">{t("userModel.spend")}</th>
                        <th className="px-3 py-2 text-center text-[10px] font-medium text-gray-500 uppercase">{t("userModel.primaryModel")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/50">
                      {userSummaries.slice(0, 12).map((u) => (
                        <tr key={u.email} className="hover:bg-gray-800/30 transition-colors">
                          <td className="px-3 py-2 text-xs text-gray-300 font-medium sticky left-0 bg-[#161b22] z-10">{maskName(u.email)}</td>
                          {allModels.map((model) => {
                            const cell = u.models.find((m) => m.model === model);
                            if (!cell || cell.requests === 0) {
                              return <td key={model} className="px-3 py-2 text-center text-[10px] text-gray-700">-</td>;
                            }
                            const maxReqs = Math.max(...userModelAggs.map((a) => a.requests));
                            const intensity = Math.min(cell.requests / maxReqs, 1);
                            return (
                              <td key={model} className="px-3 py-2 text-center">
                                <div
                                  className="inline-flex items-center justify-center min-w-[32px] px-1.5 py-0.5 rounded text-[10px] font-medium"
                                  style={{
                                    backgroundColor: `rgba(59, 130, 246, ${0.1 + intensity * 0.5})`,
                                    color: intensity > 0.3 ? "#93c5fd" : "#6b7280",
                                  }}
                                  title={`${cell.requests} req · ${cell.tokens} tokens · $${cell.spend.toFixed(4)}`}
                                >
                                  {cell.requests}
                                </div>
                              </td>
                            );
                          })}
                          <td className="px-3 py-2 text-right text-[10px] text-gray-400">${u.spend.toFixed(4)}</td>
                          <td className="px-3 py-2 text-center">
                            <span className="inline-flex px-1.5 py-0.5 text-[9px] font-medium rounded bg-cyan-900/30 text-cyan-400">
                              {u.primaryModel.split("-").slice(0, 2).join("-")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Model Preference Distribution (per user) */}
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <h4 className="text-xs font-medium text-gray-300 mb-3">{t("userModel.preference")}</h4>
                  <div className="space-y-2.5">
                    {userSummaries.slice(0, 8).map((u) => {
                      const total = u.requests;
                      return (
                        <div key={u.email}>
                          <div className="flex justify-between text-[10px] mb-1">
                            <span className="text-gray-400">{maskName(u.email)}</span>
                            <span className="text-gray-600">{total} req</span>
                          </div>
                          <div className="flex h-2 rounded-full overflow-hidden bg-gray-800">
                            {u.models.sort((a, b) => b.requests - a.requests).map((m, i) => {
                              const pct = total > 0 ? (m.requests / total) * 100 : 0;
                              const colors = ["#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444", "#10b981"];
                              return (
                                <div
                                  key={m.model}
                                  className="h-full transition-all"
                                  style={{ width: `${pct}%`, backgroundColor: colors[i % colors.length] }}
                                  title={`${m.model}: ${m.requests} req (${pct.toFixed(0)}%)`}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {/* Legend */}
                    <div className="flex flex-wrap gap-3 pt-2 border-t border-gray-800">
                      {allModels.map((m, i) => {
                        const colors = ["#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444", "#10b981"];
                        return (
                          <div key={m} className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: colors[i % colors.length] }} />
                            <span className="text-[9px] text-gray-500">{m.split("-").slice(0, 2).join("-")}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Token Efficiency per User */}
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <h4 className="text-xs font-medium text-gray-300 mb-3">{t("userModel.tokenEfficiency")}</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="pb-2 text-left text-[10px] font-medium text-gray-500">{t("userModel.user")}</th>
                          <th className="pb-2 text-right text-[10px] font-medium text-gray-500">{t("userModel.requests")}</th>
                          <th className="pb-2 text-right text-[10px] font-medium text-gray-500">{t("userModel.avgTokens")}</th>
                          <th className="pb-2 text-right text-[10px] font-medium text-gray-500">$/req</th>
                          <th className="pb-2 text-right text-[10px] font-medium text-gray-500">Out%</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800/50">
                        {userSummaries.slice(0, 10).map((u) => {
                          const avgTokens = u.requests > 0 ? u.totalTokens / u.requests : 0;
                          const costPerReq = u.requests > 0 ? u.spend / u.requests : 0;
                          const outPct = u.totalTokens > 0 ? (u.outputTokens / u.totalTokens) * 100 : 0;
                          return (
                            <tr key={u.email} className="hover:bg-gray-800/20">
                              <td className="py-1.5 text-[11px] text-gray-300">{maskName(u.email)}</td>
                              <td className="py-1.5 text-right text-[11px] text-gray-400">{u.requests}</td>
                              <td className="py-1.5 text-right text-[11px] text-gray-400">{avgTokens.toFixed(0)}</td>
                              <td className="py-1.5 text-right text-[11px] text-gray-400">${costPerReq.toFixed(5)}</td>
                              <td className="py-1.5 text-right">
                                <span className={`text-[11px] ${outPct > 70 ? "text-purple-400" : "text-gray-400"}`}>
                                  {outPct.toFixed(0)}%
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
