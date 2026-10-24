"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { formatBudgetCap, formatTokenCap, usagePercent } from "@/lib/budget-display";
import { BUDGET_PERIODS, type BudgetPeriod } from "@/lib/budget-periods";
import { MEMBER_LIMIT_ERRORS, errorKey, fill } from "@/lib/budget-ui";
import type {
  UserSession,
  ContainerInfo,
  DeptMember,
  DeptBudget,
  PendingRequest,
  MonthlyUsage,
  DepartmentListItem,
} from "@/lib/types";

interface McpAssignment {
  catalogId: string;
  name: string;
  category: string;
  enabled: boolean;
}

interface MarketplaceInfo {
  id: string;
  name: string;
  url: string;
  scope: string;
}
import DeptSelector from "@/components/dept/dept-selector";
import DeptCard from "@/components/dept/dept-card";
import StatCard from "@/components/cards/stat-card";
import { useDeploymentMode } from "@/components/deployment-mode-provider";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface DeptDashboardProps {
  user: UserSession;
  isAdmin: boolean;
}

const LIMIT_FIELD: Record<BudgetPeriod, "dailyBudget" | "weeklyBudget" | "monthlyBudget"> = {
  daily: "dailyBudget", weekly: "weeklyBudget", monthly: "monthlyBudget",
};
const usd = (n: number) => `$${n.toFixed(2)}`;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default function DeptDashboard({ user, isAdmin }: DeptDashboardProps) {
  const { t } = useI18n();
  // Governance mode has no per-user EC2 DevEnv: no container status, OS or tier columns.
  const devenv = useDeploymentMode() === "devenv";
  const [selectedDepartment, setSelectedDepartment] = useState<string>(
    isAdmin ? "all" : ""
  );
  const [departmentList, setDepartmentList] = useState<DepartmentListItem[]>([]);
  const [members, setMembers] = useState<DeptMember[]>([]);
  const [budget, setBudget] = useState<DeptBudget | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [monthlyUsage, setMonthlyUsage] = useState<MonthlyUsage[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [mcpAssignments, setMcpAssignments] = useState<McpAssignment[]>([]);
  const [mcpGatewayStatus, setMcpGatewayStatus] = useState<string>("unknown");
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitEdit, setLimitEdit] = useState<{ email: string; values: Record<BudgetPeriod, string> } | null>(null);
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const deptUrl = selectedDepartment
        ? `/api/dept?department=${selectedDepartment}`
        : "/api/dept";

      // Governance mode keeps the response order without calling the DevEnv-only /api/containers.
      const fetches: Promise<Response>[] = [
        fetch(deptUrl),
        devenv ? fetch("/api/containers") : Promise.resolve(Response.json({ success: true, data: [] })),
      ];

      if (isAdmin) {
        fetches.push(fetch("/api/dept/list"));
      }

      const results = await Promise.all(fetches);
      const [deptRes, containersRes] = results;

      if (deptRes.ok) {
        const deptData = await deptRes.json();
        if (deptData.success) {
          setMembers(deptData.data.members ?? []);
          setBudget(deptData.data.budget ?? null);
          setPendingRequests(deptData.data.pendingRequests ?? []);
          setMonthlyUsage(deptData.data.monthlyUsage ?? []);
        }
      }

      if (containersRes.ok) {
        const containersData = await containersRes.json();
        if (containersData.success) {
          setContainers(containersData.data ?? []);
        }
      }

      if (isAdmin && results[2]) {
        const listRes = results[2];
        if (listRes.ok) {
          const listData = await listRes.json();
          if (listData.success) {
            const depts = Array.isArray(listData.data) ? listData.data : listData.data?.departments ?? [];
            setDepartmentList(depts);
          }
        }
      }
      // Fetch MCP assignments + marketplaces for the selected department
      if (selectedDepartment && selectedDepartment !== "all") {
        try {
          const mcpRes = await fetch(`/api/dept/mcp?department=${selectedDepartment}`);
          if (mcpRes.ok) {
            const mcpData = await mcpRes.json();
            setMcpAssignments(mcpData.data?.assignments ?? []);
            setMcpGatewayStatus(mcpData.data?.gatewayStatus ?? "none");
            setMarketplaces(mcpData.data?.marketplaces ?? []);
          }
        } catch {
          setMcpAssignments([]);
          setMcpGatewayStatus("unknown");
          setMarketplaces([]);
        }
      }
    } catch (err) {
      console.error("Failed to fetch department data:", err);
      setError("Failed to load department data");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, selectedDepartment, devenv]);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleApprove = async (requestId: string) => {
    setActionLoading(requestId);
    setError(null);
    try {
      const res = await fetch("/api/admin/approval-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, action: "approve" }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Failed to approve request");
      } else {
        await fetchData();
      }
    } catch {
      setError("Failed to approve request");
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (requestId: string) => {
    setActionLoading(requestId);
    setError(null);
    try {
      const res = await fetch("/api/admin/approval-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, action: "reject" }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Failed to reject request");
      } else {
        await fetchData();
      }
    } catch {
      setError("Failed to reject request");
    } finally {
      setActionLoading(null);
    }
  };

  const openLimitEdit = (member: DeptMember) => {
    const l = member.limits;
    setLimitError(null);
    setLimitEdit({
      email: member.email,
      values: {
        daily: l?.dailyBudget ? String(l.dailyBudget) : "",
        weekly: l?.weeklyBudget ? String(l.weeklyBudget) : "",
        monthly: l?.monthlyBudget ? String(l.monthlyBudget) : "",
      },
    });
  };

  // Standing per-member limits (0 / empty = inherit the department default).
  const saveLimits = async () => {
    if (!limitEdit) return;
    setLimitSaving(true);
    setLimitError(null);
    try {
      const body: Record<string, unknown> = { email: limitEdit.email };
      for (const p of BUDGET_PERIODS) body[LIMIT_FIELD[p]] = Number(limitEdit.values[p]) || 0;
      const res = await fetch("/api/dept/user-budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setLimitEdit(null);
        await fetchData();
      } else {
        const text = t(errorKey("deptLimits.error", data.error, MEMBER_LIMIT_ERRORS));
        setLimitError(data.error === "exceeds_department_total" && data.deptMonthlyBudget
          ? `${text} (${usd(Number(data.deptMonthlyBudget))})`
          : text);
      }
    } catch {
      setLimitError(t("deptLimits.error.unknown"));
    } finally {
      setLimitSaving(false);
    }
  };

  const causeLabel = (cause: string | null | undefined) => (cause ? t(`blockCause.${cause}`) : "");
  const blockedMembers = members.filter((m) => m.budgetStatus?.blockCause);
  const viewerEmail = (user.email ?? "").toLowerCase();

  // Merge container status into members
  const membersWithContainerStatus = members.map((m) => {
    const container = containers.find((c) => c.subdomain === m.subdomain);
    return {
      ...m,
      containerStatus: container?.status ?? "STOPPED",
    };
  });

  // null = unlimited (cap <= 0) — no meaningful %; matches budget-check.py enforcement.
  const budgetPercent = budget ? usagePercent(budget.currentSpend, budget.monthlyBudget) : null;
  const tokenPercent = budget ? usagePercent(budget.currentTokens, budget.monthlyTokenLimit) : null;

  const isOverviewMode = isAdmin && selectedDepartment === "all";

  if (loading && members.length === 0 && !departmentList.length) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">{t("analytics.loading")}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-900/30 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Department Selector (admin only) */}
      {isAdmin && (
        <DeptSelector
          departments={departmentList}
          selected={selectedDepartment}
          onSelect={setSelectedDepartment}
        />
      )}

      {isOverviewMode ? (
        <>
          {/* Admin Overview Mode */}
          {/* Summary StatCards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title={t("dept.totalMembers") || "Total Members"}
              value={departmentList.reduce((sum, d) => sum + d.memberCount, 0)}
            />
            <StatCard
              title={t("dept.totalCost") || "Total Cost"}
              value={`$${departmentList.reduce((sum, d) => sum + d.totalCost, 0).toFixed(2)}`}
            />
            <StatCard
              title={t("dept.totalTokens") || "Total Tokens"}
              value={formatTokens(departmentList.reduce((sum, d) => sum + d.totalTokens, 0))}
            />
            <StatCard
              title={t("dept.pendingCount") || "Pending Approvals"}
              value={departmentList.reduce((sum, d) => sum + d.pendingCount, 0)}
              description={
                departmentList.reduce((sum, d) => sum + d.pendingCount, 0) > 0
                  ? "Requires attention"
                  : undefined
              }
            />
          </div>

          {/* Department Card Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {departmentList.map((dept) => (
              <DeptCard
                key={dept.department}
                dept={dept}
                onClick={setSelectedDepartment}
              />
            ))}
          </div>

          {/* Pending approvals across all departments */}
          {pendingRequests.length > 0 && (
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-gray-100 mb-4">
                {t("dept.pendingApprovals") || "Pending Approval Requests"}
                <span className="ml-2 px-2 py-0.5 text-xs bg-yellow-900/40 text-yellow-400 rounded-full">
                  {pendingRequests.length}
                </span>
              </h2>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                      <th className="pb-3 font-medium">Email</th>
                      <th className="pb-3 font-medium">{t("dept.requestType")}</th>
                      <th className="pb-3 font-medium">Subdomain</th>
                      {devenv && <th className="pb-3 font-medium">OS</th>}
                      {devenv && <th className="pb-3 font-medium">Tier</th>}
                      <th className="pb-3 font-medium">Requested</th>
                      <th className="pb-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {pendingRequests.map((req) => (
                      <tr key={req.requestId} className="text-sm">
                        <td className="py-3 text-gray-200">{req.email}</td>
                        <td className="py-3 text-gray-300">
                          {req.type === "budget_increase"
                            ? `${t(`budgetIncrease.period.${req.period}`)} +${usd(req.requestedAmount ?? 0)}`
                            : req.type}
                        </td>
                        <td className="py-3 text-gray-300">{req.subdomain}</td>
                        {devenv && <td className="py-3 text-gray-300 capitalize">{req.containerOs}</td>}
                        {devenv && <td className="py-3 text-gray-300 capitalize">{req.resourceTier}</td>}
                        <td className="py-3 text-gray-400">
                          {new Date(req.requestedAt).toLocaleDateString()}
                        </td>
                        <td className="py-3">
                          {req.type === "budget_increase" ? (
                            // Budget increases are decided on the approvals page (amount, cap checks, release status).
                            <Link href="/admin/approvals" className="text-xs text-blue-400 hover:text-blue-300">
                              {t("dept.openApprovals")}
                            </Link>
                          ) : isAdmin ? (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleApprove(req.requestId)}
                              disabled={actionLoading === req.requestId}
                              className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 text-white text-xs font-medium rounded transition-colors"
                            >
                              {actionLoading === req.requestId ? "..." : t("dept.approve") || "Approve"}
                            </button>
                            <button
                              onClick={() => handleReject(req.requestId)}
                              disabled={actionLoading === req.requestId}
                              className="px-3 py-1 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 text-white text-xs font-medium rounded transition-colors"
                            >
                              {actionLoading === req.requestId ? "..." : t("dept.reject") || "Reject"}
                            </button>
                          </div>
                          ) : (
                            // Instance requests are admin-only (the server rejects a manager's decision).
                            <span className="text-xs text-gray-500">{t("dept.adminOnlyRequest")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Detail Mode */}
          {/* Budget Overview */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-gray-100 mb-4">
                {t("dept.budgetOverview") || "Monthly Budget"}
              </h2>

              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-400">{t("dept.costUsage") || "Cost Usage"}</span>
                    <span className="text-sm text-gray-300">
                      ${budget?.currentSpend.toFixed(2) ?? "0.00"} / {formatBudgetCap(budget?.monthlyBudget)}
                    </span>
                  </div>
                  <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        (budgetPercent ?? 0) >= 90
                          ? "bg-red-500"
                          : (budgetPercent ?? 0) >= 70
                          ? "bg-yellow-500"
                          : "bg-green-500"
                      }`}
                      style={{ width: `${budgetPercent ?? 0}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{budgetPercent === null ? "Unlimited (no cap)" : `${budgetPercent}% used`}</p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-400">{t("dept.tokenUsage") || "Token Usage"}</span>
                    <span className="text-sm text-gray-300">
                      {(budget?.currentTokens ?? 0).toLocaleString()} / {formatTokenCap(budget?.monthlyTokenLimit)}
                    </span>
                  </div>
                  <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        (tokenPercent ?? 0) >= 90
                          ? "bg-red-500"
                          : (tokenPercent ?? 0) >= 70
                          ? "bg-yellow-500"
                          : "bg-blue-500"
                      }`}
                      style={{ width: `${tokenPercent ?? 0}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{tokenPercent === null ? "Unlimited (no cap)" : `${tokenPercent}% used`}</p>
                </div>
              </div>
            </div>

            {/* Monthly Usage Chart */}
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-gray-100 mb-4">
                {t("dept.monthlyTrend") || "Monthly Spend Trend"}
              </h2>
              {monthlyUsage.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={monthlyUsage}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="date" stroke="#9ca3af" fontSize={12} />
                    <YAxis stroke="#9ca3af" fontSize={12} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }}
                      labelStyle={{ color: "#f3f4f6" }}
                    />
                    <Bar dataKey="cost" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-48 text-gray-500">
                  No usage data available
                </div>
              )}
            </div>
          </div>

          {/* MCP Tools Status */}
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-100">
                MCP Tools
              </h2>
              <span className={`px-2 py-0.5 text-xs rounded-full ${
                mcpGatewayStatus === "ACTIVE" ? "bg-green-900/40 text-green-400"
                  : mcpGatewayStatus === "SYNCING" ? "bg-yellow-900/40 text-yellow-400"
                  : mcpGatewayStatus === "FAILED" ? "bg-red-900/40 text-red-400"
                  : "bg-gray-800 text-gray-500"
              }`}>
                Gateway: {mcpGatewayStatus === "none" ? "Not configured" : mcpGatewayStatus}
              </span>
            </div>
            {mcpAssignments.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {mcpAssignments.map((mcp) => (
                  <div key={mcp.catalogId} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${
                    mcp.enabled ? "border-gray-700 bg-gray-800/50" : "border-gray-800 bg-gray-900/50 opacity-60"
                  }`}>
                    <div className={`w-2 h-2 rounded-full ${mcp.enabled ? "bg-green-400" : "bg-gray-600"}`} />
                    <div>
                      <p className="text-sm font-medium text-gray-200">{mcp.name}</p>
                      <p className="text-xs text-gray-500">{mcp.category}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">No MCP tools assigned to this department</p>
            )}

            {marketplaces.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-800">
                <h3 className="text-sm font-medium text-gray-300 mb-2">Plugin Marketplaces</h3>
                <div className="space-y-1.5">
                  {marketplaces.map((m) => (
                    <div key={`${m.scope}-${m.id}`} className="flex items-center gap-2 text-xs">
                      <span className={`px-1.5 py-0.5 rounded ${
                        m.scope === "common" ? "bg-blue-500/20 text-blue-400" : "bg-purple-500/20 text-purple-400"
                      }`}>
                        {m.scope === "common" ? "Common" : m.scope}
                      </span>
                      <span className="text-gray-300">{m.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Pending Approval Requests */}
          {pendingRequests.length > 0 && (
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-gray-100 mb-4">
                {t("dept.pendingApprovals") || "Pending Approval Requests"}
                <span className="ml-2 px-2 py-0.5 text-xs bg-yellow-900/40 text-yellow-400 rounded-full">
                  {pendingRequests.length}
                </span>
              </h2>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                      <th className="pb-3 font-medium">Email</th>
                      <th className="pb-3 font-medium">{t("dept.requestType")}</th>
                      <th className="pb-3 font-medium">Subdomain</th>
                      {devenv && <th className="pb-3 font-medium">OS</th>}
                      {devenv && <th className="pb-3 font-medium">Tier</th>}
                      <th className="pb-3 font-medium">Requested</th>
                      <th className="pb-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {pendingRequests.map((req) => (
                      <tr key={req.requestId} className="text-sm">
                        <td className="py-3 text-gray-200">{req.email}</td>
                        <td className="py-3 text-gray-300">
                          {req.type === "budget_increase"
                            ? `${t(`budgetIncrease.period.${req.period}`)} +${usd(req.requestedAmount ?? 0)}`
                            : req.type}
                        </td>
                        <td className="py-3 text-gray-300">{req.subdomain}</td>
                        {devenv && <td className="py-3 text-gray-300 capitalize">{req.containerOs}</td>}
                        {devenv && <td className="py-3 text-gray-300 capitalize">{req.resourceTier}</td>}
                        <td className="py-3 text-gray-400">
                          {new Date(req.requestedAt).toLocaleDateString()}
                        </td>
                        <td className="py-3">
                          {req.type === "budget_increase" ? (
                            // Budget increases are decided on the approvals page (amount, cap checks, release status).
                            <Link href="/admin/approvals" className="text-xs text-blue-400 hover:text-blue-300">
                              {t("dept.openApprovals")}
                            </Link>
                          ) : isAdmin ? (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleApprove(req.requestId)}
                              disabled={actionLoading === req.requestId}
                              className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 text-white text-xs font-medium rounded transition-colors"
                            >
                              {actionLoading === req.requestId ? "..." : t("dept.approve") || "Approve"}
                            </button>
                            <button
                              onClick={() => handleReject(req.requestId)}
                              disabled={actionLoading === req.requestId}
                              className="px-3 py-1 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 text-white text-xs font-medium rounded transition-colors"
                            >
                              {actionLoading === req.requestId ? "..." : t("dept.reject") || "Reject"}
                            </button>
                          </div>
                          ) : (
                            // Instance requests are admin-only (the server rejects a manager's decision).
                            <span className="text-xs text-gray-500">{t("dept.adminOnlyRequest")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Currently blocked members and why (personal period, department total, token) */}
          {blockedMembers.length > 0 && (
            <div className="bg-[#161b22] rounded-xl border border-red-900/40 p-6">
              <h2 className="text-lg font-semibold text-gray-100 mb-4">
                {t("dept.blockedUsers")}
                <span className="ml-2 px-2 py-0.5 text-xs bg-red-900/40 text-red-400 rounded-full">{blockedMembers.length}</span>
              </h2>
              <ul className="divide-y divide-gray-800 text-sm">
                {blockedMembers.map((m) => {
                  const grants = BUDGET_PERIODS.filter((p) => (m.budgetStatus?.periods[p].grant ?? 0) > 0);
                  return (
                    <li key={m.email} className="py-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-gray-200">{m.email}</span>
                      <span className="text-red-400 text-xs font-medium">{causeLabel(m.budgetStatus?.blockCause)}</span>
                      <span className="text-xs text-gray-400">
                        {grants.length > 0
                          ? grants.map((p) => `${t(`budgetIncrease.period.${p}`)} +${usd(m.budgetStatus!.periods[p].grant)}`).join(" · ")
                          : t("dept.noActiveGrant")}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {blockedMembers.some((m) => m.budgetStatus?.blockCause === "department") && (
                <p className="mt-3 text-xs text-amber-300">{t("budgetIncrease.cause.department")}</p>
              )}
            </div>
          )}

          {/* Department Members */}
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-4">
              {t("dept.members") || "Department Members"}
              <span className="ml-2 text-sm font-normal text-gray-500">
                ({members.length} {t("dept.users") || "users"})
              </span>
            </h2>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="pb-3 font-medium">Email</th>
                    <th className="pb-3 font-medium">Subdomain</th>
                    {devenv && <th className="pb-3 font-medium">OS</th>}
                    {devenv && <th className="pb-3 font-medium">Tier</th>}
                    {BUDGET_PERIODS.map((p) => (
                      <th key={p} className="pb-3 font-medium text-right">{t(`budgetIncrease.period.${p}`)}</th>
                    ))}
                    <th className="pb-3 font-medium">{t("dept.blockStatus")}</th>
                    <th className="pb-3 font-medium">User Status</th>
                    {devenv && <th className="pb-3 font-medium">Container</th>}
                    <th className="pb-3 font-medium text-right">{t("dept.limits")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {membersWithContainerStatus.map((member) => (
                    <tr key={member.email} className="text-sm">
                      <td className="py-3 text-gray-200">{member.email}</td>
                      <td className="py-3 text-gray-300">{member.subdomain || "-"}</td>
                      {devenv && (
                        <td className="py-3 text-gray-300 capitalize">
                          {member.containerOs === "al2023" ? "AL2023" : "Ubuntu"}
                        </td>
                      )}
                      {devenv && <td className="py-3 text-gray-300 capitalize">{member.resourceTier}</td>}
                      {BUDGET_PERIODS.map((p) => {
                        const ps = member.budgetStatus?.periods[p];
                        if (!ps) return <td key={p} className="py-3 text-right text-gray-600">-</td>;
                        const over = ps.cap > 0 && ps.spend >= ps.cap;
                        return (
                          <td key={p} className={`py-3 text-right text-xs ${over ? "text-red-400" : "text-gray-300"}`}>
                            {usd(ps.spend)} <span className="text-gray-600">/</span>{" "}
                            {ps.cap > 0 ? usd(ps.cap) : <span className="text-gray-600">∞</span>}
                            {ps.grant > 0 && (
                              <div className="text-[10px] text-emerald-400">
                                {fill(t("budgetIncrease.basePlusGrant"), { base: usd(ps.base), grant: usd(ps.grant) })}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="py-3 text-xs">
                        {member.budgetStatus?.blockCause ? (
                          <span className="text-red-400 font-medium">{causeLabel(member.budgetStatus.blockCause)}</span>
                        ) : member.budgetStatus ? (
                          <span className="text-green-400">OK</span>
                        ) : (
                          <span className="text-gray-600">-</span>
                        )}
                      </td>
                      <td className="py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${
                            member.status === "CONFIRMED"
                              ? "bg-green-900/30 text-green-400"
                              : "bg-yellow-900/30 text-yellow-400"
                          }`}
                        >
                          {member.status}
                        </span>
                      </td>
                      {devenv && (
                        <td className="py-3">
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                              member.containerStatus === "RUNNING"
                                ? "bg-green-900/30 text-green-400"
                                : member.containerStatus === "HIBERNATED"
                                ? "bg-blue-900/30 text-blue-400"
                                : member.containerStatus === "PENDING" ||
                                  member.containerStatus === "PROVISIONING"
                                ? "bg-yellow-900/30 text-yellow-400"
                                : "bg-gray-800 text-gray-400"
                            }`}
                          >
                            {member.containerStatus === "RUNNING" && (
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                            )}
                            {member.containerStatus}
                          </span>
                        </td>
                      )}
                      <td className="py-3 text-right">
                        {member.limits && member.email.toLowerCase() !== viewerEmail && (member.role ?? "user") === "user" && (
                          <button
                            onClick={() => openLimitEdit(member)}
                            className="px-2 py-1 text-xs font-medium text-blue-400 hover:text-blue-300"
                          >
                            {t("dept.editLimits")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {members.length === 0 && (
                    <tr>
                      <td colSpan={devenv ? 11 : 8} className="py-8 text-center text-gray-500">
                        No department members found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {/* Standing member limit editor (0 / empty = inherit the department default) */}
      {limitEdit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#161b22] rounded-xl border border-gray-700 p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-gray-100 mb-1">{t("dept.editLimits")}</h3>
            <p className="text-sm text-gray-400 mb-4">{limitEdit.email}</p>
            <div className="grid grid-cols-3 gap-2">
              {BUDGET_PERIODS.map((p) => (
                <div key={p}>
                  <label htmlFor={`ml-${p}`} className="block text-xs font-medium text-gray-400 mb-1">
                    {t(`budgetIncrease.period.${p}`)} (USD)
                  </label>
                  <input
                    id={`ml-${p}`}
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={limitEdit.values[p]}
                    onChange={(e) => setLimitEdit({ ...limitEdit, values: { ...limitEdit.values, [p]: e.target.value } })}
                    className="w-full px-2 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg"
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">{t("dept.limitsHint")}</p>
            {limitError && <p className="mt-2 text-sm text-red-400">{limitError}</p>}
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setLimitEdit(null)}
                className="px-4 py-2 text-sm font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700"
              >
                {t("dept.cancel")}
              </button>
              <button
                onClick={() => void saveLimits()}
                disabled={limitSaving}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {limitSaving ? "..." : t("dept.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
