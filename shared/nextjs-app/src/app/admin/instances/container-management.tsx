"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import ContainersTable from "@/components/tables/containers-table";
import StatCard from "@/components/cards/stat-card";
import type {
  ContainerInfo,
  CognitoUser,
  StartContainerInput,
  ApiResponse,
} from "@/lib/types";

interface ContainerManagementProps {
  domainName?: string;
  devSubdomain?: string;
}

export default function ContainerManagement({
  domainName = "atomai.click",
  devSubdomain = "dev",
}: ContainerManagementProps) {
  const { t } = useI18n();
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [users, setUsers] = useState<CognitoUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStartForm, setShowStartForm] = useState(false);
  const [starting, setStarting] = useState(false);
  const [selectedUser, setSelectedUser] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [efsInfo, setEfsInfo] = useState<{ sizeBytes: number; sizeStandard: number; sizeIA: number; state: string; numberOfMountTargets: number; perUser?: Record<string, number> } | null>(null);
  const [filterStorage, setFilterStorage] = useState<string>("all");

  const fetchData = useCallback(async () => {
    try {
      const [containersRes, usersRes, efsRes] = await Promise.all([
        fetch("/api/containers"),
        fetch("/api/users"),
        fetch("/api/containers?action=efs"),
      ]);
      const containersJson = (await containersRes.json()) as ApiResponse<
        ContainerInfo[]
      >;
      const usersJson = (await usersRes.json()) as ApiResponse<CognitoUser[]>;
      const efsJson = (await efsRes.json()) as ApiResponse<{ sizeBytes: number; sizeStandard: number; sizeIA: number; state: string; numberOfMountTargets: number; perUser?: Record<string, number> }>;

      setContainers(containersJson.data ?? []);
      setUsers(usersJson.data ?? []);
      setEfsInfo(efsJson.data ?? null);
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;

    const user = users.find((u) => u.username === selectedUser);
    if (!user) return;

    setStarting(true);
    setError(null);

    try {
      const input: StartContainerInput = {
        username: user.username,
        subdomain: user.subdomain,
        department: user.department ?? "default",
        containerOs: user.containerOs,
        resourceTier: user.resourceTier,
        securityPolicy: user.securityPolicy,
        storageType: "ebs",
      };

      const res = await fetch("/api/containers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = (await res.json()) as ApiResponse<{ taskArn: string }>;
      if (!json.success) {
        setError(json.error ?? "Failed to start container");
        return;
      }
      setShowStartForm(false);
      setSelectedUser("");
      void fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async (taskArn: string) => {
    if (!confirm("Are you sure you want to stop this instance?")) return;
    // taskArn is actually instanceId in EC2 mode; find subdomain from containers list
    const instance = containers.find((c) => c.taskArn === taskArn);
    const subdomain = instance?.subdomain;
    if (!subdomain) {
      console.error("Cannot find subdomain for instance:", taskArn);
      return;
    }
    try {
      await fetch("/api/containers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain }),
      });
      void fetchData();
    } catch (err) {
      console.error("Failed to stop instance:", err);
    }
  };

  const runningContainers = containers.filter((c) => c.status === "RUNNING");
  const pendingContainers = containers.filter(
    (c) => c.status === "PENDING" || c.status === "PROVISIONING"
  );

  // Users without running containers
  const activeSubdomains = new Set(
    containers
      .filter((c) => c.status === "RUNNING" || c.status === "PENDING")
      .map((c) => c.subdomain)
  );
  const availableUsers = users.filter(
    (u) => u.enabled && !activeSubdomains.has(u.subdomain)
  );

  if (loading && containers.length === 0 && !efsInfo) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-500">Loading containers...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <StatCard
          title={t("containers.running")}
          value={runningContainers.length}
          description={t("common.active")}
        />
        <StatCard
          title={t("containers.pending")}
          value={pendingContainers.length}
          description={t("common.startingUp")}
        />
        <StatCard
          title={t("containers.totalUsers")}
          value={users.length}
          description={t("users.registered")}
        />
        <StatCard
          title={t("containers.available")}
          value={availableUsers.length}
          description={t("common.canStart")}
        />
        <StatCard
          title={t("containers.utilization")}
          value={users.length > 0 ? `${Math.round(((runningContainers.length + pendingContainers.length) / users.length) * 100)}%` : "0%"}
          description="Instances / Users"
        />
      </div>

      {/* Instance Insights */}
      {containers.length > 0 && (() => {
        const osCounts: Record<string, number> = {};
        const tierCounts: Record<string, number> = {};
        for (const c of containers.filter((c) => c.status === "RUNNING" || c.status === "PENDING")) {
          osCounts[c.containerOs] = (osCounts[c.containerOs] ?? 0) + 1;
          tierCounts[c.resourceTier] = (tierCounts[c.resourceTier] ?? 0) + 1;
        }
        const total = runningContainers.length + pendingContainers.length;
        return (
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
            <h3 className="text-sm font-medium text-gray-300 mb-3">{t("containers.breakdown")}</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-2">
                <p className="text-[10px] text-gray-500 uppercase">{t("containers.byOs")}</p>
                {Object.entries(osCounts).map(([os, count]) => (
                  <div key={os} className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-14">{os === "al2023" ? "AL2023" : "Ubuntu"}</span>
                    <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden max-w-[150px]">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }} />
                    </div>
                    <span className="text-[10px] text-gray-500">{count}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <p className="text-[10px] text-gray-500 uppercase">{t("containers.byTier")}</p>
                {Object.entries(tierCounts).map(([tier, count]) => {
                  const color = tier === "light" ? "bg-gray-500" : tier === "standard" ? "bg-blue-500" : "bg-purple-500";
                  return (
                    <div key={tier} className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 w-14 capitalize">{tier}</span>
                      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden max-w-[150px]">
                        <div className={`h-full rounded-full ${color}`} style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }} />
                      </div>
                      <span className="text-[10px] text-gray-500">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-gray-800">
              <p className="text-xs text-gray-500 mb-1">Storage</p>
              <div className="flex gap-2">
                <span className="px-2 py-0.5 text-xs bg-blue-900/40 text-blue-400 rounded">
                  EBS: {containers.filter(c => c.storageType === "ebs").length}
                </span>
                <span className="px-2 py-0.5 text-xs bg-green-900/40 text-green-400 rounded">
                  EBS: {containers.length}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-100">Instances</h2>
        <div className="flex gap-2">
          <select
            value={filterStorage}
            onChange={(e) => setFilterStorage(e.target.value)}
            className="px-2 py-1.5 text-xs bg-[#0d1117] border border-gray-700 text-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="all">All Storage</option>
            <option value="ebs">EBS</option>
            <option value="ebs">EBS</option>
          </select>
          <button
            onClick={() => void fetchData()}
            className="px-3 py-2 text-sm font-medium text-gray-300 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowStartForm(!showStartForm)}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            {showStartForm ? t("containers.cancel") : t("containers.startContainer")}
          </button>
        </div>
      </div>

      {/* Start container form */}
      {showStartForm && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-gray-100 mb-4">
            Start Container for User
          </h3>
          {error && (
            <div className="mb-4 p-3 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-lg">
              {error}
            </div>
          )}
          <form onSubmit={(e) => void handleStart(e)} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                Select User
              </label>
              <select
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
                className="w-full max-w-md px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="">Choose a user...</option>
                {availableUsers.map((user) => (
                  <option key={user.username} value={user.username}>
                    {user.email} ({user.subdomain}) - {user.containerOs === "al2023" ? "AL2023" : "Ubuntu"} / {user.resourceTier} / {user.securityPolicy} / {(user.storageType ?? "efs").toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            {selectedUser && (() => {
              const user = users.find((u) => u.username === selectedUser);
              if (!user) return null;
              return (
                <div className="bg-[#0d1117] rounded-lg p-4 text-sm">
                  <h4 className="font-medium text-gray-300 mb-2">Container Config</h4>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-gray-400">
                    <div>
                      <span className="text-gray-500">OS:</span>{" "}
                      {user.containerOs === "al2023" ? "Amazon Linux 2023" : "Ubuntu 24.04"}
                    </div>
                    <div>
                      <span className="text-gray-500">Tier:</span>{" "}
                      {user.resourceTier}
                    </div>
                    <div>
                      <span className="text-gray-500">Security:</span>{" "}
                      {user.securityPolicy}
                    </div>
                    <div>
                      <span className="text-gray-500">Storage:</span>{" "}
                      <span className={user.storageType === "ebs" ? "text-blue-400" : "text-green-400"}>
                        {(user.storageType ?? "efs").toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">Subdomain:</span>{" "}
                      {user.subdomain}
                    </div>
                  </div>
                </div>
              );
            })()}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={starting || !selectedUser}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {starting ? "Starting..." : t("containers.startContainer")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Containers table */}
      <ContainersTable containers={containers} onStop={handleStop} domainName={domainName} devSubdomain={devSubdomain} />
    </div>
  );
}
