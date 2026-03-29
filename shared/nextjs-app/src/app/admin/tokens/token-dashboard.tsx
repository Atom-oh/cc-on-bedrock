"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import StatCard from "@/components/cards/stat-card";
import HorizontalBarChart from "@/components/charts/horizontal-bar-chart";

interface TokenData {
  period: string;
  startDate: string;
  endDate: string;
  totals: {
    tokens: number;
    cost: number;
    requests: number;
    users: number;
    departments: number;
  };
  topUsers: {
    userId: string;
    department: string;
    totalTokens: number;
    totalCost: number;
    requests: number;
  }[];
  departmentBreakdown: {
    name: string;
    tokens: number;
    cost: number;
    requests: number;
    userCount: number;
  }[];
}

export default function TokenDashboard() {
  const { t } = useI18n();
  const [data, setData] = useState<TokenData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<"1d" | "7d" | "30d">("7d");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/tokens?period=${period}`);
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch token data:", err);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const formatTokens = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
      ? `${(n / 1_000).toFixed(0)}K`
      : String(n);

  const formatCost = (n: number) => `$${n.toFixed(2)}`;

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-500">Loading token data...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-500">No data available</div>
      </div>
    );
  }

  const deptChartData = data.departmentBreakdown.map((d) => ({
    name: d.name,
    value: d.tokens,
  }));

  return (
    <div className="space-y-6">
      {/* Period Selector */}
      <div className="flex items-center gap-2">
        {(["1d", "7d", "30d"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              period === p
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            {p === "1d" ? t("analytics.past1d") : p === "7d" ? t("analytics.past7d") : t("analytics.past30d")}
          </button>
        ))}
        <button
          onClick={() => void fetchData()}
          className="ml-auto px-3 py-1.5 text-xs font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
        >
          {t("analytics.refresh")}
        </button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          title={t("overview.totalCost")}
          value={formatCost(data.totals.cost)}
          description={`${data.startDate} ~ ${data.endDate}`}
        />
        <StatCard
          title="Total Tokens"
          value={formatTokens(data.totals.tokens)}
          description="Input + Output"
        />
        <StatCard
          title={t("overview.totalRequests")}
          value={data.totals.requests.toLocaleString()}
          description="API calls"
        />
        <StatCard
          title={t("overview.activeUsers")}
          value={data.totals.users}
          description="Unique users"
        />
        <StatCard
          title={t("overview.deptCount")}
          value={data.totals.departments}
          description="Active departments"
        />
      </div>

      {/* Department Token Usage Chart */}
      <HorizontalBarChart
        data={deptChartData}
        title={t("dept.tokenDistribution")}
        color="#3b82f6"
        valueFormatter={formatTokens}
      />

      {/* Department Budget Utilization */}
      <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
        <h4 className="text-sm font-medium text-gray-300 mb-3">
          Department Budget Utilization
        </h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-700">
                <th className="pb-2 font-medium">Department</th>
                <th className="pb-2 font-medium text-right">Tokens</th>
                <th className="pb-2 font-medium text-right">Cost</th>
                <th className="pb-2 font-medium text-right">Requests</th>
                <th className="pb-2 font-medium text-right">Users</th>
              </tr>
            </thead>
            <tbody>
              {data.departmentBreakdown.map((dept) => (
                <tr key={dept.name} className="border-b border-gray-800">
                  <td className="py-2 text-gray-200">{dept.name}</td>
                  <td className="py-2 text-right text-gray-300">
                    {formatTokens(dept.tokens)}
                  </td>
                  <td className="py-2 text-right text-gray-300">
                    {formatCost(dept.cost)}
                  </td>
                  <td className="py-2 text-right text-gray-300">
                    {dept.requests.toLocaleString()}
                  </td>
                  <td className="py-2 text-right text-gray-300">
                    {dept.userCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Top Users Table */}
      <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
        <h4 className="text-sm font-medium text-gray-300 mb-3">
          Top 10 Users by Token Usage
        </h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-700">
                <th className="pb-2 font-medium">#</th>
                <th className="pb-2 font-medium">User</th>
                <th className="pb-2 font-medium">Department</th>
                <th className="pb-2 font-medium text-right">Tokens</th>
                <th className="pb-2 font-medium text-right">Cost</th>
                <th className="pb-2 font-medium text-right">Requests</th>
              </tr>
            </thead>
            <tbody>
              {data.topUsers.map((user, idx) => (
                <tr key={user.userId} className="border-b border-gray-800">
                  <td className="py-2 text-gray-500">{idx + 1}</td>
                  <td className="py-2 text-gray-200">{user.userId}</td>
                  <td className="py-2 text-gray-400">{user.department}</td>
                  <td className="py-2 text-right text-gray-300">
                    {formatTokens(user.totalTokens)}
                  </td>
                  <td className="py-2 text-right text-gray-300">
                    {formatCost(user.totalCost)}
                  </td>
                  <td className="py-2 text-right text-gray-300">
                    {user.requests.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
