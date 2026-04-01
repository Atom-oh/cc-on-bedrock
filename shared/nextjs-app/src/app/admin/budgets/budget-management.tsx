"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import StatCard from "@/components/cards/stat-card";
import DonutChart from "@/components/charts/donut-chart";
import HorizontalBarChart from "@/components/charts/horizontal-bar-chart";

interface DepartmentBudget {
  department: string;
  monthlyBudget: number;
  currentSpend: number;
  updatedAt: string;
}

interface UserBudget {
  userId: string;
  department: string;
  dailyTokenLimit: number;
  monthlyBudget: number;
  currentSpend: number;
  updatedAt: string;
}

interface EditModal {
  type: "department" | "user";
  id: string;
  currentBudget: number;
  currentLimit?: number;
}

const DEPT_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#f97316", "#6366f1"];

export default function BudgetManagement() {
  const { t } = useI18n();
  const [departments, setDepartments] = useState<DepartmentBudget[]>([]);
  const [users, setUsers] = useState<UserBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editModal, setEditModal] = useState<EditModal | null>(null);
  const [createModal, setCreateModal] = useState<{ type: "department" | "user" } | null>(null);
  const [createId, setCreateId] = useState("");
  const [createDept, setCreateDept] = useState("");
  const [newBudget, setNewBudget] = useState("");
  const [newLimit, setNewLimit] = useState("");
  const [activeSection, setActiveSection] = useState<"departments" | "users">("departments");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/budgets");
      const json = await res.json();
      if (json.success && json.data) {
        setDepartments(json.data.departments ?? []);
        setUsers(json.data.users ?? []);
      }
    } catch (err) {
      console.error("Failed to fetch budget data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const openEditModal = (type: "department" | "user", id: string, currentBudget: number, currentLimit?: number) => {
    setEditModal({ type, id, currentBudget, currentLimit });
    setNewBudget(String(currentBudget));
    setNewLimit(currentLimit !== undefined ? String(currentLimit) : "");
  };

  const handleSave = async () => {
    if (!editModal) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { type: editModal.type, id: editModal.id };
      if (newBudget) body.monthlyBudget = Number(newBudget);
      if (editModal.type === "user" && newLimit) body.dailyTokenLimit = Number(newLimit);

      const res = await fetch("/api/admin/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        setEditModal(null);
        void fetchData();
      } else {
        alert(json.error ?? "Failed to update budget");
      }
    } catch {
      alert("Failed to save budget");
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!createModal || !createId.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        type: createModal.type,
        id: createId.trim(),
        monthlyBudget: Number(newBudget) || 0,
      };
      if (createModal.type === "user") {
        body.dailyTokenLimit = Number(newLimit) || 100000;
      }

      const res = await fetch("/api/admin/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        setCreateModal(null);
        setCreateId("");
        setCreateDept("");
        setNewBudget("");
        setNewLimit("");
        void fetchData();
      } else {
        alert(json.error ?? "Failed to create budget");
      }
    } catch {
      alert("Failed to create budget");
    } finally {
      setSaving(false);
    }
  };

  const formatCurrency = (n: number) => `$${n.toFixed(2)}`;
  const formatTokens = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` : String(n);
  const getUtilization = (current: number, budget: number) => (budget === 0 ? 0 : Math.round((current / budget) * 100));
  const getUtilizationColor = (pct: number) => (pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-yellow-500" : "bg-green-500");

  // Computed stats
  const totalBudget = departments.reduce((s, d) => s + d.monthlyBudget, 0);
  const totalSpend = departments.reduce((s, d) => s + d.currentSpend, 0);
  const avgUtilization = totalBudget > 0 ? Math.round((totalSpend / totalBudget) * 100) : 0;
  const overBudgetCount = departments.filter(d => d.monthlyBudget > 0 && d.currentSpend >= d.monthlyBudget).length;

  // Chart data
  const donutData = departments
    .filter(d => d.monthlyBudget > 0)
    .map((d, i) => ({ name: d.department, value: d.monthlyBudget, color: DEPT_COLORS[i % DEPT_COLORS.length] }));

  const barData = departments
    .filter(d => d.monthlyBudget > 0)
    .sort((a, b) => b.currentSpend - a.currentSpend)
    .map(d => ({ name: d.department, value: d.currentSpend }));

  if (loading && departments.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-500">Loading budget data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Departments" value={departments.length} description="Active budget groups" />
        <StatCard
          title="Total Budget"
          value={formatCurrency(totalBudget)}
          description="Monthly allocation"
        />
        <StatCard
          title="Total Spend"
          value={formatCurrency(totalSpend)}
          description={`${avgUtilization}% utilized`}
          trend={avgUtilization > 0 ? { value: avgUtilization, isPositive: avgUtilization < 80 } : undefined}
        />
        <StatCard
          title="Over Budget"
          value={overBudgetCount}
          description={overBudgetCount > 0 ? "Departments exceeded" : "All within limits"}
          trend={overBudgetCount > 0 ? { value: overBudgetCount, isPositive: false } : undefined}
        />
      </div>

      {/* Charts Row */}
      {departments.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <DonutChart
            data={donutData}
            title="Budget Allocation by Department"
            centerLabel="Total"
            centerValue={formatCurrency(totalBudget)}
            valueFormatter={(v) => formatCurrency(v)}
          />
          <HorizontalBarChart
            data={barData}
            title="Current Spend by Department"
            color="#f59e0b"
            valueFormatter={(v) => formatCurrency(v)}
          />
        </div>
      )}

      {/* Section Tabs */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800">
        <div className="flex border-b border-gray-800">
          <button
            onClick={() => setActiveSection("departments")}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-all ${
              activeSection === "departments"
                ? "border-blue-500 text-blue-400 bg-blue-900/10"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            Department Budgets ({departments.length})
          </button>
          <button
            onClick={() => setActiveSection("users")}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-all ${
              activeSection === "users"
                ? "border-blue-500 text-blue-400 bg-blue-900/10"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            User Token Limits ({users.length})
          </button>
        </div>

        <div className="p-6">
          {/* Department Budgets */}
          {activeSection === "departments" && (
            <>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-gray-500">{departments.length === 0 ? "No department budgets configured yet." : "Monthly budget limits per department."}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setCreateModal({ type: "department" }); setNewBudget(""); setCreateId(""); }}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    + Add Department
                  </button>
                  <button
                    onClick={() => void fetchData()}
                    className="px-3 py-1.5 text-xs font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {departments.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-700">
                        <th className="pb-2 font-medium">Department</th>
                        <th className="pb-2 font-medium text-right">Monthly Budget</th>
                        <th className="pb-2 font-medium text-right">Current Spend</th>
                        <th className="pb-2 font-medium text-center">Utilization</th>
                        <th className="pb-2 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {departments.map((dept) => {
                        const util = getUtilization(dept.currentSpend, dept.monthlyBudget);
                        const isOver = dept.monthlyBudget > 0 && dept.currentSpend >= dept.monthlyBudget;
                        return (
                          <tr key={dept.department} className={`border-b border-gray-800 ${isOver ? "bg-red-900/10" : ""}`}>
                            <td className="py-3">
                              <span className="text-gray-200">{dept.department}</span>
                              {isOver && <span className="ml-2 text-xs text-red-400 font-medium">OVER</span>}
                            </td>
                            <td className="py-3 text-right text-gray-300">{formatCurrency(dept.monthlyBudget)}</td>
                            <td className="py-3 text-right text-gray-300">{formatCurrency(dept.currentSpend)}</td>
                            <td className="py-3">
                              <div className="flex items-center justify-center gap-2">
                                <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden" role="progressbar" aria-valuenow={util} aria-valuemin={0} aria-valuemax={100}>
                                  <div className={`h-full ${getUtilizationColor(util)}`} style={{ width: `${Math.min(util, 100)}%` }} />
                                </div>
                                <span className="text-xs text-gray-400 w-10">{util}%</span>
                              </div>
                            </td>
                            <td className="py-3 text-right">
                              <button
                                onClick={() => openEditModal("department", dept.department, dept.monthlyBudget)}
                                className="px-2 py-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
                              >
                                Edit
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* User Budgets */}
          {activeSection === "users" && (
            <>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-gray-500">{users.length === 0 ? "No user budgets configured yet." : "Per-user daily token limits and monthly budgets."}</p>
                <button
                  onClick={() => { setCreateModal({ type: "user" }); setNewBudget(""); setNewLimit("100000"); setCreateId(""); setCreateDept(""); }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  + Add User Budget
                </button>
              </div>

              {users.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-700">
                        <th className="pb-2 font-medium">User</th>
                        <th className="pb-2 font-medium">Department</th>
                        <th className="pb-2 font-medium text-right">Daily Token Limit</th>
                        <th className="pb-2 font-medium text-right">Monthly Budget</th>
                        <th className="pb-2 font-medium text-right">Current Spend</th>
                        <th className="pb-2 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => {
                        const isOver = user.monthlyBudget > 0 && user.currentSpend >= user.monthlyBudget;
                        return (
                          <tr key={user.userId} className={`border-b border-gray-800 ${isOver ? "bg-red-900/10" : ""}`}>
                            <td className="py-3">
                              <span className="text-gray-200">{user.userId}</span>
                              {isOver && <span className="ml-2 text-xs text-red-400 font-medium">OVER</span>}
                            </td>
                            <td className="py-3 text-gray-400">{user.department}</td>
                            <td className="py-3 text-right text-gray-300">{formatTokens(user.dailyTokenLimit)}</td>
                            <td className="py-3 text-right text-gray-300">{formatCurrency(user.monthlyBudget)}</td>
                            <td className="py-3 text-right text-gray-300">{formatCurrency(user.currentSpend)}</td>
                            <td className="py-3 text-right">
                              <button
                                onClick={() => openEditModal("user", user.userId, user.monthlyBudget, user.dailyTokenLimit)}
                                className="px-2 py-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
                              >
                                Edit
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Create Modal */}
      {createModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#161b22] rounded-xl border border-gray-700 p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-gray-100 mb-4">
              Add {createModal.type === "department" ? "Department" : "User"} Budget
            </h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="create-id" className="block text-sm font-medium text-gray-400 mb-1">
                  {createModal.type === "department" ? "Department Name" : "User ID (subdomain)"}
                </label>
                <input
                  id="create-id"
                  type="text"
                  value={createId}
                  onChange={(e) => setCreateId(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={createModal.type === "department" ? "engineering" : "user-subdomain"}
                />
              </div>
              <div>
                <label htmlFor="create-budget" className="block text-sm font-medium text-gray-400 mb-1">Monthly Budget (USD)</label>
                <input
                  id="create-budget"
                  type="number"
                  value={newBudget}
                  onChange={(e) => setNewBudget(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="500.00"
                  min="0"
                  step="0.01"
                />
              </div>
              {createModal.type === "user" && (
                <div>
                  <label htmlFor="create-limit" className="block text-sm font-medium text-gray-400 mb-1">Daily Token Limit</label>
                  <input
                    id="create-limit"
                    type="number"
                    value={newLimit}
                    onChange={(e) => setNewLimit(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="100000"
                    min="0"
                    step="1000"
                  />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setCreateModal(null)} className="px-4 py-2 text-sm font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors">Cancel</button>
              <button onClick={() => void handleCreate()} disabled={saving || !createId.trim()} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {saving ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#161b22] rounded-xl border border-gray-700 p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-gray-100 mb-4">
              Edit {editModal.type === "department" ? "Department" : "User"} Budget
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              {editModal.type === "department" ? "Department" : "User"}: <span className="text-gray-200">{editModal.id}</span>
            </p>
            <div className="space-y-4">
              <div>
                <label htmlFor="edit-budget" className="block text-sm font-medium text-gray-400 mb-1">Monthly Budget (USD)</label>
                <input
                  id="edit-budget"
                  type="number"
                  value={newBudget}
                  onChange={(e) => setNewBudget(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="100.00"
                  min="0"
                  step="0.01"
                />
              </div>
              {editModal.type === "user" && (
                <div>
                  <label htmlFor="edit-limit" className="block text-sm font-medium text-gray-400 mb-1">Daily Token Limit</label>
                  <input
                    id="edit-limit"
                    type="number"
                    value={newLimit}
                    onChange={(e) => setNewLimit(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="100000"
                    min="0"
                    step="1000"
                  />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditModal(null)} className="px-4 py-2 text-sm font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors">Cancel</button>
              <button onClick={() => void handleSave()} disabled={saving} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
