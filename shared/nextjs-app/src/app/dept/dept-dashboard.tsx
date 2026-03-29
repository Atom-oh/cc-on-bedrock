"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import type {
  UserSession,
  ContainerInfo,
  DeptMember,
  DeptBudget,
  PendingRequest,
  MonthlyUsage,
  DepartmentListItem,
} from "@/lib/types";
import DeptSelector from "@/components/dept/dept-selector";
import DeptCard from "@/components/dept/dept-card";
import StatCard from "@/components/cards/stat-card";
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default function DeptDashboard({ user, isAdmin }: DeptDashboardProps) {
  const { t } = useI18n();
  const [selectedDepartment, setSelectedDepartment] = useState<string>(
    isAdmin ? "all" : ""
  );
  const [departmentList, setDepartmentList] = useState<DepartmentListItem[]>([]);
  const [members, setMembers] = useState<DeptMember[]>([]);
  const [budget, setBudget] = useState<DeptBudget | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [monthlyUsage, setMonthlyUsage] = useState<MonthlyUsage[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const deptUrl = selectedDepartment
        ? `/api/dept?department=${selectedDepartment}`
        : "/api/dept";

      const fetches: Promise<Response>[] = [
        fetch(deptUrl),
        fetch("/api/containers"),
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
    } catch (err) {
      console.error("Failed to fetch department data:", err);
      setError("Failed to load department data");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, selectedDepartment]);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleApprove = async (requestId: string) => {
    setActionLoading(requestId);
    setError(null);
    try {
      const res = await fetch("/api/dept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", requestId }),
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
      const res = await fetch("/api/dept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", requestId }),
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

  // Merge container status into members
  const membersWithContainerStatus = members.map((m) => {
    const container = containers.find((c) => c.subdomain === m.subdomain);
    return {
      ...m,
      containerStatus: container?.status ?? "STOPPED",
    };
  });

  const budgetPercent = budget
    ? Math.min(100, Math.round((budget.currentSpend / budget.monthlyBudget) * 100))
    : 0;

  const tokenPercent = budget
    ? Math.min(100, Math.round((budget.currentTokens / budget.monthlyTokenLimit) * 100))
    : 0;

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
                      <th className="pb-3 font-medium">Subdomain</th>
                      <th className="pb-3 font-medium">OS</th>
                      <th className="pb-3 font-medium">Tier</th>
                      <th className="pb-3 font-medium">Requested</th>
                      <th className="pb-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {pendingRequests.map((req) => (
                      <tr key={req.requestId} className="text-sm">
                        <td className="py-3 text-gray-200">{req.email}</td>
                        <td className="py-3 text-gray-300">{req.subdomain}</td>
                        <td className="py-3 text-gray-300 capitalize">{req.containerOs}</td>
                        <td className="py-3 text-gray-300 capitalize">{req.resourceTier}</td>
                        <td className="py-3 text-gray-400">
                          {new Date(req.requestedAt).toLocaleDateString()}
                        </td>
                        <td className="py-3">
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
                      ${budget?.currentSpend.toFixed(2) ?? "0.00"} / ${budget?.monthlyBudget.toFixed(2) ?? "0.00"}
                    </span>
                  </div>
                  <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        budgetPercent >= 90
                          ? "bg-red-500"
                          : budgetPercent >= 70
                          ? "bg-yellow-500"
                          : "bg-green-500"
                      }`}
                      style={{ width: `${budgetPercent}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{budgetPercent}% used</p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-400">{t("dept.tokenUsage") || "Token Usage"}</span>
                    <span className="text-sm text-gray-300">
                      {(budget?.currentTokens ?? 0).toLocaleString()} / {(budget?.monthlyTokenLimit ?? 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        tokenPercent >= 90
                          ? "bg-red-500"
                          : tokenPercent >= 70
                          ? "bg-yellow-500"
                          : "bg-blue-500"
                      }`}
                      style={{ width: `${tokenPercent}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{tokenPercent}% used</p>
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
                      <th className="pb-3 font-medium">Subdomain</th>
                      <th className="pb-3 font-medium">OS</th>
                      <th className="pb-3 font-medium">Tier</th>
                      <th className="pb-3 font-medium">Requested</th>
                      <th className="pb-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {pendingRequests.map((req) => (
                      <tr key={req.requestId} className="text-sm">
                        <td className="py-3 text-gray-200">{req.email}</td>
                        <td className="py-3 text-gray-300">{req.subdomain}</td>
                        <td className="py-3 text-gray-300 capitalize">{req.containerOs}</td>
                        <td className="py-3 text-gray-300 capitalize">{req.resourceTier}</td>
                        <td className="py-3 text-gray-400">
                          {new Date(req.requestedAt).toLocaleDateString()}
                        </td>
                        <td className="py-3">
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
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                    <th className="pb-3 font-medium">OS</th>
                    <th className="pb-3 font-medium">Tier</th>
                    <th className="pb-3 font-medium">User Status</th>
                    <th className="pb-3 font-medium">Container</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {membersWithContainerStatus.map((member) => (
                    <tr key={member.email} className="text-sm">
                      <td className="py-3 text-gray-200">{member.email}</td>
                      <td className="py-3 text-gray-300">{member.subdomain || "-"}</td>
                      <td className="py-3 text-gray-300 capitalize">
                        {member.containerOs === "al2023" ? "AL2023" : "Ubuntu"}
                      </td>
                      <td className="py-3 text-gray-300 capitalize">{member.resourceTier}</td>
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
                      <td className="py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                            member.containerStatus === "RUNNING"
                              ? "bg-green-900/30 text-green-400"
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
                    </tr>
                  ))}
                  {members.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-gray-500">
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
    </div>
  );
}
