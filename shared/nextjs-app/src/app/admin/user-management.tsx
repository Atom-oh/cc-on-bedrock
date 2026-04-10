"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import UsersTable from "@/components/tables/users-table";
import StatCard from "@/components/cards/stat-card";
import type { CognitoUser, CreateUserInput, ApiResponse } from "@/lib/types";

export default function UserManagement() {
  const { t } = useI18n();
  const [users, setUsers] = useState<CognitoUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [email, setEmail] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [containerOs, setContainerOs] = useState<CreateUserInput["containerOs"]>("ubuntu");
  const [resourceTier, setResourceTier] = useState<CreateUserInput["resourceTier"]>("standard");
  const [securityPolicy, setSecurityPolicy] = useState<CreateUserInput["securityPolicy"]>("restricted");
  const [storageType, setStorageType] = useState<CreateUserInput["storageType"]>("ebs");

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      const json = (await res.json()) as ApiResponse<CognitoUser[]>;
      if (json.success && json.data) {
        setUsers(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch users:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          subdomain,
          department: "default",
          containerOs,
          resourceTier,
          securityPolicy,
          storageType,
        } satisfies CreateUserInput),
      });
      const json = (await res.json()) as ApiResponse<CognitoUser>;
      if (!json.success) {
        setError(json.error ?? "Failed to create user");
        return;
      }
      // Reset form and refresh
      setEmail("");
      setSubdomain("");
      setContainerOs("ubuntu");
      setResourceTier("standard");
      setSecurityPolicy("restricted");
      setStorageType("ebs");
      setShowCreateForm(false);
      void fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const handleResetEnvironment = async (username: string) => {
    if (!confirm(`"${username}" 의 컨테이너 환경을 초기화합니다.\nCognito 계정은 유지되며 사용자는 재신청할 수 있습니다.`)) {
      return;
    }
    try {
      await fetch(`/api/users?username=${encodeURIComponent(username)}`, {
        method: "DELETE",
      });
      void fetchUsers();
    } catch (err) {
      console.error("Failed to reset environment:", err);
    }
  };

  const handlePermanentDelete = async (username: string) => {
    if (!confirm(`⚠️ "${username}" Cognito 계정을 완전히 삭제합니다.\n이 작업은 복구할 수 없습니다. 계속하시겠습니까?`)) {
      return;
    }
    try {
      await fetch(`/api/users?username=${encodeURIComponent(username)}&action=permanent`, {
        method: "DELETE",
      });
      void fetchUsers();
    } catch (err) {
      console.error("Failed to delete user:", err);
    }
  };

  const handleToggle = async (username: string, enable: boolean) => {
    try {
      await fetch("/api/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, action: enable ? "enable" : "disable" }),
      });
      void fetchUsers();
    } catch (err) {
      console.error("Failed to toggle user:", err);
    }
  };

  const handleUpdate = async (username: string, field: string, value: string) => {
    try {
      const res = await fetch("/api/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, [field]: value }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? `Failed to update ${field}`);
        return;
      }
      void fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  };

  // User insights
  const activeUsers = users.filter((u) => u.enabled);
  const withSubdomain = users.filter((u) => u.subdomain);
  const osCounts = { ubuntu: 0, al2023: 0 };
  const tierCounts = { light: 0, standard: 0, power: 0 };
  const policyCounts = { open: 0, restricted: 0, locked: 0 };
  for (const u of users) {
    osCounts[u.containerOs] = (osCounts[u.containerOs] ?? 0) + 1;
    tierCounts[u.resourceTier] = (tierCounts[u.resourceTier] ?? 0) + 1;
    policyCounts[u.securityPolicy] = (policyCounts[u.securityPolicy] ?? 0) + 1;
  }

  return (
    <div className="space-y-6">
      {/* User Insights */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard title={t("users.totalUsers")} value={users.length} description={t("users.registered")} />
        <StatCard title={t("users.active")} value={activeUsers.length} description={`${users.length > 0 ? ((activeUsers.length / users.length) * 100).toFixed(0) : 0}% ${t("users.enabled")}`} />
        <StatCard title={t("users.withEnv")} value={withSubdomain.length} description={t("users.canUseCC")} />
        <StatCard title={t("users.osSplit")} value={`${osCounts.ubuntu}/${osCounts.al2023}`} description="Ubuntu / AL2023" />
        <StatCard title={t("users.tierSplit")} value={`${tierCounts.light}/${tierCounts.standard}/${tierCounts.power}`} description="L / S / P" />
      </div>

      {/* Security Policy Distribution */}
      {users.length > 0 && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-3">{t("users.securityDist")}</h3>
          <div className="flex gap-6">
            {Object.entries(policyCounts).filter(([, v]) => v > 0).map(([policy, count]) => {
              const pct = (count / users.length) * 100;
              const color = policy === "open" ? "bg-green-500" : policy === "restricted" ? "bg-yellow-500" : "bg-red-500";
              return (
                <div key={policy} className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${color}`} />
                  <span className="text-xs text-gray-400 capitalize">{policy}</span>
                  <span className="text-xs text-gray-600">{count} ({pct.toFixed(0)}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {users.length} user{users.length !== 1 ? "s" : ""} total
        </p>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
        >
          {showCreateForm ? t("containers.cancel") : t("users.createUser")}
        </button>
      </div>

      {/* Create user form */}
      {showCreateForm && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-gray-100 mb-4">
            Create New User
          </h3>
          {error && (
            <div className="mb-4 p-3 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-lg">
              {error}
            </div>
          )}
          <form onSubmit={(e) => void handleCreate(e)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 placeholder-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Subdomain
                </label>
                <input
                  type="text"
                  required
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 placeholder-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="user01"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Container OS
                </label>
                <select
                  value={containerOs}
                  onChange={(e) => setContainerOs(e.target.value as CreateUserInput["containerOs"])}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="ubuntu">Ubuntu 24.04</option>
                  <option value="al2023">Amazon Linux 2023</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Resource Tier
                </label>
                <select
                  value={resourceTier}
                  onChange={(e) => setResourceTier(e.target.value as CreateUserInput["resourceTier"])}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="light">Light (1 vCPU / 4 GiB)</option>
                  <option value="standard">Standard (2 vCPU / 8 GiB)</option>
                  <option value="power">Power (4 vCPU / 12 GiB)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Security Policy
                </label>
                <select
                  value={securityPolicy}
                  onChange={(e) => setSecurityPolicy(e.target.value as CreateUserInput["securityPolicy"])}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="open">Open (Education/Lab)</option>
                  <option value="restricted">Restricted (General)</option>
                  <option value="locked">Locked (High Security)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Storage Type
                </label>
                <select
                  value={storageType}
                  onChange={(e) => setStorageType(e.target.value as CreateUserInput["storageType"])}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="ebs">EBS (Enterprise)</option>
                  <option value="efs">EFS (Simple)</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? "Creating..." : t("users.createUser")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Users table */}
      {loading && users.length === 0 ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-sm text-gray-500">Loading users...</div>
        </div>
      ) : (
        <UsersTable
          users={users}
          onResetEnvironment={handleResetEnvironment}
          onPermanentDelete={handlePermanentDelete}
          onToggle={handleToggle}
          onUpdate={handleUpdate}
        />
      )}
    </div>
  );
}
