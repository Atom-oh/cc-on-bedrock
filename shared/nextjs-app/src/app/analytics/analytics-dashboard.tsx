"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import FilterBar from "@/components/filter-bar";
import LeaderboardChart from "@/components/charts/leaderboard-chart";
import AreaTrendChart from "@/components/charts/area-trend-chart";
import MultiLineChart from "@/components/charts/multi-line-chart";
import HorizontalBarChart from "@/components/charts/horizontal-bar-chart";
import DonutChart from "@/components/charts/donut-chart";
import UserDailyTrendChart from "@/components/charts/user-daily-trend-chart";
import type { UserDailyTrend } from "@/lib/usage-client";
import type {
  SpendLog,
  ModelMetrics,
  ApiResponse,
} from "@/lib/types";

// KeySpendInfo type - kept inline for compatibility (LiteLLM removed)
interface KeySpendInfo {
  token: string;
  key_alias: string;
  key_name: string;
  spend: number;
  max_budget: number | null;
  last_active: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

// Department summary from API
interface DepartmentSummary {
  department: string;
  totalTokens: number;
  totalCost: number;
  requests: number;
  userCount: number;
}

// User usage summary from API
interface UserUsageSummary {
  userId: string;
  department: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  requests: number;
  models: string[];
}

// Extended SpendLog with department field (from API route mapping)
interface SpendLogWithDept extends SpendLog {
  department?: string;
}

interface AnalyticsDashboardProps {
  isAdmin: boolean;
}

interface SystemHealth {
  status: string;
  db: string;
  cache: string;
  architecture: string;
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
  // Clean up non-user names for display
  if (name.startsWith("cc-on-bedrock-ecs-task")) return "shared-role";
  if (name.startsWith("cc-on-bedrock-")) return name.replace("cc-on-bedrock-", "");
  if (/^i-[0-9a-f]{10,}$/.test(name)) return `host-${name.slice(-6)}`;
  return name;
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

// Build token_hash_tail -> user_alias map from keySpendList
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

const DEPT_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#14b8a6",
  "#f97316",
];

export default function AnalyticsDashboard({
  isAdmin,
}: AnalyticsDashboardProps) {
  const { t, locale } = useI18n();
  const [timeRange, setTimeRange] = useState<TimeRange>("1d");
  const [filterUser, setFilterUser] = useState("all");
  const [filterModel, setFilterModel] = useState("all");
  const [filterDept, setFilterDept] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [logs, setLogs] = useState<SpendLogWithDept[]>([]);
  const [modelMetrics, setModelMetrics] = useState<ModelMetrics[]>([]);
  const [keySpendList, setKeySpendList] = useState<KeySpendInfo[]>([]);
  const [deptSummaries, setDeptSummaries] = useState<DepartmentSummary[]>([]);
  const [userSummariesApi, setUserSummariesApi] = useState<UserUsageSummary[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [userTrend, setUserTrend] = useState<UserDailyTrend | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const { start, end } = getDateRange(timeRange);

    try {
      const fetches: Promise<Response | null>[] = [
        fetch(`/api/usage?action=spend_logs&start_date=${start}&end_date=${end}`),
      ];

      if (isAdmin) {
        fetches.push(
          fetch(`/api/usage?action=model_metrics&start_date=${start}&end_date=${end}`),
          fetch("/api/usage?action=key_spend_list"),
          fetch("/api/usage?action=system_health"),
          fetch(`/api/usage?action=department_summaries&start_date=${start}&end_date=${end}`),
          fetch(`/api/usage?action=user_summaries&start_date=${start}&end_date=${end}`),
        );
      }

      const [logsRes, metricsRes, keyRes, healthRes, deptRes, userSumRes] = await Promise.all(fetches);

      const logsJson = (await logsRes!.json()) as ApiResponse<SpendLogWithDept[]>;
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
      if (deptRes) {
        const deptJson = (await deptRes.json()) as ApiResponse<DepartmentSummary[]>;
        setDeptSummaries(deptJson.data ?? []);
      }
      if (userSumRes) {
        const userSumJson = (await userSumRes.json()) as ApiResponse<UserUsageSummary[]>;
        setUserSummariesApi(userSumJson.data ?? []);
      }

      // Per-user daily trend (server scopes by role: admin=all, dept-manager=dept, user=self)
      try {
        const trendRes = await fetch(`/api/usage?action=user_daily_trend&start_date=${start}&end_date=${end}`);
        if (trendRes.ok) {
          const trendJson = (await trendRes.json()) as ApiResponse<UserDailyTrend>;
          setUserTrend(trendJson.data ?? null);
        }
      } catch (trendErr) {
        console.error("User daily trend fetch failed:", trendErr);
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

  // Build filter options from raw data
  const allUsers = [...new Set(logs.map((l) => {
    const raw = l.user || l.api_key?.slice(-8) || "unknown";
    return keyAlias.get(raw) ?? raw;
  }))].sort();
  const allModels = [...new Set(logs.map((l) => (l.model ?? "").replace("bedrock/", "").replace("global.anthropic.", "").replace("apac.anthropic.", "")).filter(Boolean))].sort();
  const allDepartments = [...new Set(logs.map((l) => (l as SpendLogWithDept).department ?? "default").filter(Boolean))].sort();

  // Apply filters
  const filteredLogs = logs.filter((l) => {
    const raw = l.user || l.api_key?.slice(-8) || "unknown";
    const userName = keyAlias.get(raw) ?? raw;
    const model = (l.model ?? "").replace("bedrock/", "").replace("global.anthropic.", "").replace("apac.anthropic.", "");
    const dept = (l as SpendLogWithDept).department ?? "default";
    if (filterUser !== "all" && userName !== filterUser) return false;
    if (filterModel !== "all" && model !== filterModel) return false;
    if (filterDept !== "all" && dept !== filterDept) return false;
    if (searchText && !userName.toLowerCase().includes(searchText.toLowerCase()) && !model.toLowerCase().includes(searchText.toLowerCase())) return false;
    return true;
  });

  const userAggs = aggregateByUser(filteredLogs, keyAlias);
  const dateAggs = aggregateByDate(filteredLogs);
  const totalSpend = filteredLogs.reduce((s, l) => s + l.spend, 0);
  const totalRequests = filteredLogs.length;
  const activeUsers = new Set(filteredLogs.map((l) => l.user || l.api_key)).size;
  const avgLatency =
    modelMetrics.length > 0
      ? modelMetrics.reduce((s, m) => s + m.avg_latency_seconds * 1000, 0) /
        modelMetrics.length
      : 0;

  // Department count
  const deptCount = deptSummaries.length > 0
    ? deptSummaries.length
    : allDepartments.length;

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
  const userTrendData = aggregateByDateAndUser(filteredLogs, top5Users, keyAlias);
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

  // --- User x Model cross analysis ---
  interface UserModelAgg {
    user: string;
    model: string;
    requests: number;
    tokens: number;
    spend: number;
  }
  const userModelMap = new Map<string, UserModelAgg>();
  for (const log of filteredLogs) {
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

  // All unique models used in cross-analysis
  const matrixModels = [...new Set(userModelAggs.map((a) => a.model))].sort();

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

  // --- Department Analysis ---
  const deptCostData = [...deptSummaries]
    .sort((a, b) => b.totalCost - a.totalCost)
    .map((d) => ({ name: d.department, value: d.totalCost }));

  const deptRequestData = [...deptSummaries]
    .sort((a, b) => b.requests - a.requests)
    .map((d) => ({ name: d.department, value: d.requests }));

  const deptTokenDonutData = [...deptSummaries]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((d, i) => ({
      name: d.department,
      value: d.totalTokens,
      color: DEPT_COLORS[i % DEPT_COLORS.length],
    }));

  const topDeptByCost = deptSummaries.length > 0
    ? [...deptSummaries].sort((a, b) => b.totalCost - a.totalCost)[0]
    : null;
  const topDeptByTokens = deptSummaries.length > 0
    ? [...deptSummaries].sort((a, b) => b.totalTokens - a.totalTokens)[0]
    : null;
  const topDeptByUsers = deptSummaries.length > 0
    ? [...deptSummaries].sort((a, b) => b.userCount - a.userCount)[0]
    : null;

  // --- User x Department Insights (from API data) ---
  const userDeptRows = [...userSummariesApi]
    .sort((a, b) => b.totalCost - a.totalCost);

  // --- Request Analysis ---
  const statusDistribution = (() => {
    const counts: Record<string, number> = {};
    for (const log of filteredLogs) {
      const s = log.status === "success" ? "Success" : "Error";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({
      name,
      value,
      color: name === "Success" ? "#10b981" : "#ef4444",
    }));
  })();

  const callTypeDistribution = (() => {
    const counts: Record<string, number> = {};
    for (const log of filteredLogs) {
      const ct = log.call_type || "unknown";
      counts[ct] = (counts[ct] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .map(([name, value]) => ({ name, value }));
  })();

  const successRate = (() => {
    const success = filteredLogs.filter((l) => l.status === "success").length;
    return filteredLogs.length > 0 ? (success / filteredLogs.length) * 100 : 0;
  })();

  // --- Hourly Activity ---
  const hourlyActivity = (() => {
    const hours = Array.from({ length: 24 }, (_, h) => ({
      hour: `${String(h).padStart(2, "0")}:00`,
      requests: 0,
      tokens: 0,
    }));
    for (const log of filteredLogs) {
      const h = new Date(log.startTime).getHours();
      if (h >= 0 && h < 24) {
        hours[h].requests += 1;
        hours[h].tokens += log.total_tokens;
      }
    }
    return hours;
  })();
  const peakHour = hourlyActivity.reduce(
    (max, h) => (h.requests > max.requests ? h : max),
    hourlyActivity[0]
  );

  // --- Engagement Depth (Tool Acceptance Proxy) ---
  const engagementByUser = (() => {
    // Group logs by user x date to compute "sessions"
    const sessions = new Map<string, { count: number; tokens: number; success: number }>();
    for (const log of filteredLogs) {
      const rawUser = log.user || log.api_key?.slice(-8) || "unknown";
      const user = (rawUser && keyAlias.get(rawUser)) ?? rawUser;
      const date = log.startTime?.split("T")[0] ?? "unknown";
      const key = `${user}::${date}`;
      const s = sessions.get(key) ?? { count: 0, tokens: 0, success: 0 };
      s.count += 1;
      s.tokens += log.total_tokens;
      if (log.status === "success") s.success += 1;
      sessions.set(key, s);
    }

    // Aggregate per user
    const userMap = new Map<string, { sessions: number; totalRequests: number; totalTokens: number; totalSuccess: number; avgDepth: number }>();
    for (const [key, val] of sessions) {
      const user = key.split("::")[0];
      const u = userMap.get(user) ?? { sessions: 0, totalRequests: 0, totalTokens: 0, totalSuccess: 0, avgDepth: 0 };
      u.sessions += 1;
      u.totalRequests += val.count;
      u.totalTokens += val.tokens;
      u.totalSuccess += val.success;
      userMap.set(user, u);
    }

    return Array.from(userMap.entries()).map(([user, val]) => ({
      user,
      sessions: val.sessions,
      avgDepth: val.sessions > 0 ? val.totalRequests / val.sessions : 0,
      acceptanceRate: val.totalRequests > 0 ? (val.totalSuccess / val.totalRequests) * 100 : 0,
      avgTokensPerSession: val.sessions > 0 ? val.totalTokens / val.sessions : 0,
      totalRequests: val.totalRequests,
    })).sort((a, b) => b.totalRequests - a.totalRequests);
  })();

  const overallAcceptance = engagementByUser.length > 0
    ? engagementByUser.reduce((s, u) => s + u.acceptanceRate, 0) / engagementByUser.length
    : 0;
  const avgSessionDepth = engagementByUser.length > 0
    ? engagementByUser.reduce((s, u) => s + u.avgDepth, 0) / engagementByUser.length
    : 0;

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

      {/* Per-user daily usage trend (scoped server-side by role) */}
      {userTrend && userTrend.series.length > 0 && (
        <div className="mb-6">
          <UserDailyTrendChart
            trend={userTrend}
            title={userTrend.series.length > 1 ? "Department Daily Usage" : "My Daily Usage"}
          />
        </div>
      )}

      {/* Filters */}
      {isAdmin && logs.length > 0 && (
        <FilterBar
          searchPlaceholder={t("analytics.title") + "..."}
          searchValue={searchText}
          onSearchChange={setSearchText}
          filters={[
            {
              key: "department",
              label: t("dept.filterLabel"),
              value: filterDept,
              onChange: setFilterDept,
              options: [
                { value: "all", label: locale === "ko" ? "전체" : "All", count: allDepartments.length },
                ...allDepartments.map((d) => ({ value: d, label: d })),
              ],
            },
            {
              key: "user",
              label: locale === "ko" ? "사용자" : "User",
              value: filterUser,
              onChange: setFilterUser,
              options: [
                { value: "all", label: locale === "ko" ? "전체" : "All", count: allUsers.length },
                ...allUsers.map((u) => ({ value: u, label: u })),
              ],
            },
            {
              key: "model",
              label: locale === "ko" ? "모델" : "Model",
              value: filterModel,
              onChange: setFilterModel,
              options: [
                { value: "all", label: locale === "ko" ? "전체" : "All", count: allModels.length },
                ...allModels.map((m) => ({ value: m, label: m.split("-").slice(0, 3).join("-") })),
              ],
            },
          ]}
        />
      )}

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
                title={t("overview.deptCount")}
                value={String(deptCount)}
              />
            </div>
          </Section>

          {/* Section: Department Analysis */}
          {isAdmin && deptSummaries.length > 0 && (
            <Section title={t("dept.title")}>
              {/* Department stat cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <DarkStatCard
                  title={t("dept.totalDepts")}
                  value={String(deptSummaries.length)}
                  subtitle={t("dept.totalDeptsDesc")}
                />
                <DarkStatCard
                  title={t("dept.topByCost")}
                  value={topDeptByCost?.department ?? "-"}
                  subtitle={topDeptByCost ? formatCost(topDeptByCost.totalCost) : ""}
                />
                <DarkStatCard
                  title={t("dept.topByTokens")}
                  value={topDeptByTokens?.department ?? "-"}
                  subtitle={topDeptByTokens ? formatNumber(topDeptByTokens.totalTokens) : ""}
                />
                <DarkStatCard
                  title={t("dept.topByUsers")}
                  value={topDeptByUsers?.department ?? "-"}
                  subtitle={topDeptByUsers ? `${topDeptByUsers.userCount} ${t("dept.users")}` : ""}
                />
              </div>

              {/* Department charts */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <HorizontalBarChart
                  data={deptCostData}
                  title={t("dept.costByDept")}
                  color="#3b82f6"
                  valueFormatter={(v) => formatCost(v)}
                />
                <HorizontalBarChart
                  data={deptRequestData}
                  title={t("dept.requestsByDept")}
                  color="#10b981"
                />
                <DonutChart
                  data={deptTokenDonutData}
                  title={t("dept.tokenDistribution")}
                  centerValue={formatNumber(deptSummaries.reduce((s, d) => s + d.totalTokens, 0))}
                  centerLabel={t("dept.totalTokensLabel")}
                />
              </div>
            </Section>
          )}

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
                  subtitle={systemHealth?.architecture ?? "Direct Bedrock"}
                />
              </div>
            </Section>
          )}

          {/* Section: System Health */}
          {isAdmin && systemHealth && (
            <Section title={t("system.title")} defaultOpen={false}>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Bedrock API</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${systemHealth.status === "healthy" ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.status}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{t("system.database")}</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${systemHealth.db === "dynamodb" ? "bg-green-400" : "bg-red-400"}`} />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.db}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Architecture</p>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-400" />
                    <span className="text-sm font-medium text-gray-200">{systemHealth.architecture ?? "Direct Bedrock"}</span>
                  </div>
                </div>
                <div className="bg-[#161b22] rounded-lg border border-gray-800 p-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Models</p>
                  <span className="text-sm font-medium text-gray-200">{systemHealth.model_count || modelMetrics.length} active</span>
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

          {/* Section: Leaderboard */}
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

          {/* Section: Token Usage Trends */}
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

          {/* Section: Usage Patterns */}
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

          {/* Section: Model Performance */}
          {isAdmin && modelMetrics.length > 0 && (
            <Section title={t("modelPerf.title")}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <DonutChart
                  data={modelRequestData.map((m, i) => ({
                    name: m.name,
                    value: m.requests,
                    color: DEPT_COLORS[i % DEPT_COLORS.length],
                  }))}
                  title={t("modelPerf.usageDistribution")}
                  centerValue={String(modelRequestData.reduce((s, m) => s + m.requests, 0))}
                  centerLabel={t("modelPerf.totalRequests")}
                />
                <div className="bg-[#161b22] rounded-lg border border-gray-800 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800">
                    <h4 className="text-sm font-medium text-gray-300">{t("modelPerf.summaryTable")}</h4>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-800 bg-[#0d1117]">
                          <th className="px-3 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.model")}</th>
                          <th className="px-3 py-2 text-right text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.requests")}</th>
                          <th className="px-3 py-2 text-right text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.tokens")}</th>
                          <th className="px-3 py-2 text-right text-[10px] font-medium text-gray-500 uppercase">{t("bedrockModel.spend")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800/50">
                        {modelRequestData.map((m) => (
                          <tr key={m.name} className="hover:bg-gray-800/30 transition-colors">
                            <td className="px-3 py-2 text-xs text-gray-300 font-medium">{m.name}</td>
                            <td className="px-3 py-2 text-right text-xs text-gray-400">{m.requests.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right text-xs text-gray-400">{formatNumber(m.tokens)}</td>
                            <td className="px-3 py-2 text-right text-xs text-gray-400">{formatCost(m.spend)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
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

          {/* Section: User x Department Insights */}
          {isAdmin && userDeptRows.length > 0 && (
            <Section title={t("userDept.title")}>
              <div className="bg-[#161b22] rounded-lg border border-gray-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-800">
                  <h4 className="text-xs font-medium text-gray-300">{t("userDept.tableTitle")}</h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-800 bg-[#0d1117]">
                        <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("userDept.user")}</th>
                        <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("userDept.department")}</th>
                        <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("userDept.modelsUsed")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("userDept.requests")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("userDept.inputTokens")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("userDept.outputTokens")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("userDept.totalCost")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("userDept.avgTokensPerReq")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/50">
                      {userDeptRows.slice(0, 20).map((u) => {
                        const avgTok = u.requests > 0 ? u.totalTokens / u.requests : 0;
                        return (
                          <tr key={u.userId} className="hover:bg-gray-800/30 transition-colors">
                            <td className="px-4 py-2.5 text-sm text-gray-200 font-medium">{maskName(u.userId)}</td>
                            <td className="px-4 py-2.5">
                              <span className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded bg-cyan-900/30 text-cyan-400">
                                {u.department}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                {u.models.slice(0, 3).map((m) => (
                                  <span key={m} className="inline-flex px-1.5 py-0.5 text-[9px] font-medium rounded bg-gray-800 text-gray-400">
                                    {m.replace("bedrock/", "").replace("global.anthropic.", "").replace("apac.anthropic.", "").split("-").slice(0, 2).join("-")}
                                  </span>
                                ))}
                                {u.models.length > 3 && (
                                  <span className="text-[9px] text-gray-600">+{u.models.length - 3}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-right text-sm text-gray-400">{u.requests.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right text-sm text-gray-400">{formatNumber(u.inputTokens)}</td>
                            <td className="px-4 py-2.5 text-right text-sm text-gray-400">{formatNumber(u.outputTokens)}</td>
                            <td className="px-4 py-2.5 text-right text-sm text-gray-400 font-medium">{formatCost(u.totalCost)}</td>
                            <td className="px-4 py-2.5 text-right text-sm text-gray-400">{formatNumber(avgTok)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </Section>
          )}

          {/* Section: User x Model Insights */}
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
                        {matrixModels.map((m) => (
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
                          {matrixModels.map((model) => {
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
                      {matrixModels.map((m, i) => {
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

          {/* Section: Request Analysis */}
          {isAdmin && filteredLogs.length > 0 && (
            <Section title={t("requestAnalysis.title")}>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <DonutChart
                  data={statusDistribution}
                  title={t("requestAnalysis.successRate")}
                  centerValue={`${successRate.toFixed(1)}%`}
                  centerLabel={t("requestAnalysis.successLabel")}
                />
                <DonutChart
                  data={callTypeDistribution}
                  title={t("requestAnalysis.callTypes")}
                  centerValue={String(callTypeDistribution.length)}
                  centerLabel={t("requestAnalysis.typesLabel")}
                />
                <DonutChart
                  data={[
                    { name: "Input", value: totalInputTokens, color: "#3b82f6" },
                    { name: "Output", value: totalOutputTokens, color: "#8b5cf6" },
                  ]}
                  title={t("requestAnalysis.tokenRatio")}
                  centerValue={`${outputRatio.toFixed(0)}%`}
                  centerLabel="Output"
                />
              </div>
            </Section>
          )}

          {/* Section: Hourly Activity */}
          {filteredLogs.length > 0 && (
            <Section title={t("hourlyActivity.title")}>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Hourly heatmap bar */}
                <div className="lg:col-span-2 bg-gray-900 rounded-lg border border-gray-700 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-medium text-gray-300">{t("hourlyActivity.distribution")}</h4>
                    <span className="text-[10px] text-gray-500">
                      {t("hourlyActivity.peakHour")}: {peakHour.hour} ({peakHour.requests} req)
                    </span>
                  </div>
                  <div className="flex items-end gap-[3px] h-32">
                    {hourlyActivity.map((h) => {
                      const maxReqs = Math.max(...hourlyActivity.map((x) => x.requests), 1);
                      const pct = (h.requests / maxReqs) * 100;
                      const intensity = h.requests / maxReqs;
                      return (
                        <div key={h.hour} className="flex-1 flex flex-col items-center gap-1 group relative">
                          <div
                            className="w-full rounded-t-sm transition-all hover:opacity-80"
                            style={{
                              height: `${Math.max(pct, 2)}%`,
                              backgroundColor: `rgba(59, 130, 246, ${0.2 + intensity * 0.8})`,
                            }}
                            title={`${h.hour}: ${h.requests} requests, ${formatNumber(h.tokens)} tokens`}
                          />
                          {/* Show label every 3 hours */}
                          {parseInt(h.hour) % 3 === 0 && (
                            <span className="text-[8px] text-gray-600 absolute -bottom-4">
                              {h.hour.replace(":00", "")}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-6 flex justify-between text-[9px] text-gray-600">
                    <span>00:00</span>
                    <span>06:00</span>
                    <span>12:00</span>
                    <span>18:00</span>
                    <span>23:00</span>
                  </div>
                </div>

                {/* Activity summary cards */}
                <div className="space-y-3">
                  <DarkStatCard
                    title={t("hourlyActivity.peakHour")}
                    value={peakHour.hour}
                    subtitle={`${peakHour.requests} ${t("hourlyActivity.requests")}`}
                  />
                  <DarkStatCard
                    title={t("hourlyActivity.avgPerHour")}
                    value={formatNumber(filteredLogs.length / 24)}
                    subtitle={t("hourlyActivity.requestsPerHour")}
                  />
                  <DarkStatCard
                    title={t("hourlyActivity.activeHours")}
                    value={String(hourlyActivity.filter((h) => h.requests > 0).length)}
                    subtitle={`/ 24 ${t("hourlyActivity.hours")}`}
                  />
                </div>
              </div>
            </Section>
          )}

          {/* Section: Tool Acceptance & Engagement */}
          {isAdmin && engagementByUser.length > 0 && (
            <Section title={t("toolAcceptance.title")}>
              {/* Overview stats */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <DarkStatCard
                  title={t("toolAcceptance.overallRate")}
                  value={`${overallAcceptance.toFixed(1)}%`}
                  subtitle={t("toolAcceptance.overallRateDesc")}
                />
                <DarkStatCard
                  title={t("toolAcceptance.avgSessionDepth")}
                  value={avgSessionDepth.toFixed(1)}
                  subtitle={t("toolAcceptance.avgSessionDepthDesc")}
                />
                <DarkStatCard
                  title={t("toolAcceptance.totalSessions")}
                  value={String(engagementByUser.reduce((s, u) => s + u.sessions, 0))}
                  subtitle={t("toolAcceptance.totalSessionsDesc")}
                />
                <DarkStatCard
                  title={t("toolAcceptance.activeDevs")}
                  value={String(engagementByUser.length)}
                  subtitle={t("toolAcceptance.activeDevsDesc")}
                />
              </div>

              {/* Per-user engagement table */}
              <div className="bg-[#161b22] rounded-lg border border-gray-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-800">
                  <h4 className="text-xs font-medium text-gray-300">{t("toolAcceptance.perUser")}</h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-800 bg-[#0d1117]">
                        <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("toolAcceptance.user")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("toolAcceptance.sessions")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("toolAcceptance.totalReqs")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("toolAcceptance.sessionDepth")}</th>
                        <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">{t("toolAcceptance.tokensPerSession")}</th>
                        <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{t("toolAcceptance.acceptRate")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/50">
                      {engagementByUser.slice(0, 12).map((u) => {
                        const barColor = u.acceptanceRate > 95 ? "bg-green-500" : u.acceptanceRate > 80 ? "bg-yellow-500" : "bg-red-500";
                        return (
                          <tr key={u.user} className="hover:bg-gray-800/30 transition-colors">
                            <td className="px-4 py-2.5 text-sm text-gray-200">{maskName(u.user)}</td>
                            <td className="px-4 py-2.5 text-right text-sm text-gray-400">{u.sessions}</td>
                            <td className="px-4 py-2.5 text-right text-sm text-gray-400">{u.totalRequests}</td>
                            <td className="px-4 py-2.5 text-right">
                              <span className={`text-sm font-medium ${u.avgDepth > avgSessionDepth ? "text-blue-400" : "text-gray-400"}`}>
                                {u.avgDepth.toFixed(1)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right text-sm text-gray-400">
                              {formatNumber(u.avgTokensPerSession)}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden max-w-[100px]">
                                  <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(u.acceptanceRate, 100)}%` }} />
                                </div>
                                <span className="text-[10px] text-gray-500 w-12">{u.acceptanceRate.toFixed(1)}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
