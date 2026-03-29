"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";

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

export default function BudgetManagement() {
  const { t } = useI18n();
  const [departments, setDepartments] = useState<DepartmentBudget[]>([]);
  const [users, setUsers] = useState<UserBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editModal, setEditModal] = useState<EditModal | null>(null);
  const [newBudget, setNewBudget] = useState("");
  const [newLimit, setNewLimit] = useState("");

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
  }, [fetchData]);

  const openEditModal = (
    type: "department" | "user",
    id: string,
    currentBudget: number,
    currentLimit?: number
  ) => {
    setEditModal({ type, id, currentBudget, currentLimit });
    setNewBudget(String(currentBudget));
    setNewLimit(currentLimit !== undefined ? String(currentLimit) : "");
  };

  const handleSave = async () => {
    if (!editModal) return;
    setSaving(true);

    try {
      const body: Record<string, unknown> = {
        type: editModal.type,
        id: editModal.id,
      };

      if (newBudget) {
        body.monthlyBudget = Number(newBudget);
      }
      if (editModal.type === "user" && newLimit) {
        body.dailyTokenLimit = Number(newLimit);
      }

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
    } catch (err) {
      console.error("Failed to save budget:", err);
      alert("Failed to save budget");
    } finally {
      setSaving(false);
    }
  };

  const formatCurrency = (n: number) => `$${n.toFixed(2)}`;
  const formatTokens = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
      ? `${(n / 1_000).toFixed(0)}K`
      : String(n);

  const getUtilization = (current: number, budget: number) => {
    if (budget === 0) return 0;
    return Math.round((current / budget) * 100);
  };

  const getUtilizationColor = (pct: number) => {
    if (pct >= 90) return "bg-red-500";
    if (pct >= 75) return "bg-yellow-500";
    return "bg-green-500";
  };

  if (loading && departments.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-500">Loading budget data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Department Budgets */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-100">
            Department Budgets
          </h3>
          <button
            onClick={() => void fetchData()}
            className="px-3 py-1.5 text-xs font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
          >
            {t("common.refresh")}
          </button>
        </div>

        {departments.length === 0 ? (
          <p className="text-sm text-gray-500">No department budgets configured</p>
        ) : (
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
                  return (
                    <tr key={dept.department} className="border-b border-gray-800">
                      <td className="py-3 text-gray-200">{dept.department}</td>
                      <td className="py-3 text-right text-gray-300">
                        {formatCurrency(dept.monthlyBudget)}
                      </td>
                      <td className="py-3 text-right text-gray-300">
                        {formatCurrency(dept.currentSpend)}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center justify-center gap-2">
                          <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${getUtilizationColor(util)}`}
                              style={{ width: `${Math.min(util, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-400 w-10">
                            {util}%
                          </span>
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        <button
                          onClick={() =>
                            openEditModal("department", dept.department, dept.monthlyBudget)
                          }
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
      </div>

      {/* User Budgets */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <h3 className="text-lg font-semibold text-gray-100 mb-4">
          User Token Limits
        </h3>

        {users.length === 0 ? (
          <p className="text-sm text-gray-500">No user budgets configured</p>
        ) : (
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
                {users.map((user) => (
                  <tr key={user.userId} className="border-b border-gray-800">
                    <td className="py-3 text-gray-200">{user.userId}</td>
                    <td className="py-3 text-gray-400">{user.department}</td>
                    <td className="py-3 text-right text-gray-300">
                      {formatTokens(user.dailyTokenLimit)}
                    </td>
                    <td className="py-3 text-right text-gray-300">
                      {formatCurrency(user.monthlyBudget)}
                    </td>
                    <td className="py-3 text-right text-gray-300">
                      {formatCurrency(user.currentSpend)}
                    </td>
                    <td className="py-3 text-right">
                      <button
                        onClick={() =>
                          openEditModal(
                            "user",
                            user.userId,
                            user.monthlyBudget,
                            user.dailyTokenLimit
                          )
                        }
                        className="px-2 py-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#161b22] rounded-xl border border-gray-700 p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-gray-100 mb-4">
              Edit {editModal.type === "department" ? "Department" : "User"} Budget
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              {editModal.type === "department" ? "Department" : "User"}:{" "}
              <span className="text-gray-200">{editModal.id}</span>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Monthly Budget (USD)
                </label>
                <input
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
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    Daily Token Limit
                  </label>
                  <input
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
              <button
                onClick={() => setEditModal(null)}
                className="px-4 py-2 text-sm font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
              >
                {t("containers.cancel")}
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
