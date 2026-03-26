"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import type { UserSession, ContainerInfo } from "@/lib/types";
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
}

interface DeptMember {
  username: string;
  email: string;
  subdomain: string;
  containerOs: string;
  resourceTier: string;
  status: string;
  containerStatus?: string;
}

interface DeptBudget {
  department: string;
  monthlyBudget: number;
  currentSpend: number;
  monthlyTokenLimit: number;
  currentTokens: number;
}

interface PendingRequest {
  requestId: string;
  email: string;
  subdomain: string;
  containerOs: string;
  resourceTier: string;
  requestedAt: string;
  status: "pending" | "approved" | "rejected";
}

interface MonthlyUsage {
  date: string;
  cost: number;
  tokens: number;
}

export default function DeptDashboard({ user }: DeptDashboardProps) {
  const { t } = useI18n();
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
      const [deptRes, containersRes] = await Promise.all([
        fetch("/api/dept"),
        fetch("/api/containers"),
      ]);

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
    } catch (err) {
      console.error("Failed to fetch department data:", err);
      setError("Failed to load department data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000); // Refresh every minute
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

  if (loading) {
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
    </div>
  );
}
