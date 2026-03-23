"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import FilterBar from "@/components/filter-bar";
import HealthCard from "@/components/cards/health-card";
import StatCard from "@/components/cards/stat-card";
import ContainersTable from "@/components/tables/containers-table";
import AreaTrendChart from "@/components/charts/area-trend-chart";
import type { HealthStatus, ContainerInfo, ApiResponse } from "@/lib/types";

interface MonitoringDashboardProps {
  domainName?: string;
  devSubdomain?: string;
}

interface SystemHealth {
  status: string;
  db: string;
  cache: string;
  litellm_version: string;
  model_count: number;
}

interface ContainerMetrics {
  cpuUtilized: number;
  cpuReserved: number;
  cpuUtilizationPct: number;
  memoryUtilized: number;
  memoryReserved: number;
  memoryUtilizationPct: number;
  networkRxBytes: number;
  networkTxBytes: number;
  storageReadBytes: number;
  storageWriteBytes: number;
  taskCount: number;
  containerInstanceCount: number;
}

interface MetricsTimeSeries {
  timestamps: string[];
  cpuUtilized: number[];
  memoryUtilized: number[];
  networkRx: number[];
  networkTx: number[];
}

interface TaskDefMetrics {
  taskDefFamily: string;
  cpuUtilized: number;
  cpuReserved: number;
  memoryUtilized: number;
  memoryReserved: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function UtilizationBar({ label, used, total, unit, color }: {
  label: string; used: number; total: number; unit: string; color: string;
}) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const barColor = pct > 80 ? "bg-red-500" : pct > 60 ? "bg-yellow-500" : color;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className="text-gray-300">{used.toFixed(0)} / {total.toFixed(0)} {unit} ({pct.toFixed(1)}%)</span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

export default function MonitoringDashboard({
  domainName = "example.com",
  devSubdomain = "dev",
}: MonitoringDashboardProps) {
  const { t, locale } = useI18n();
  const [healthStatuses, setHealthStatuses] = useState<HealthStatus[]>([]);
  const [filterUser, setFilterUser] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [cwMetrics, setCwMetrics] = useState<ContainerMetrics | null>(null);
  const [cwTimeSeries, setCwTimeSeries] = useState<MetricsTimeSeries | null>(null);
  const [taskDefMetrics, setTaskDefMetrics] = useState<TaskDefMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [healthRes, containersRes, sysRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/containers"),
        fetch("/api/litellm?action=system_health"),
      ]);

      const healthJson = (await healthRes.json()) as {
        status: string;
        checks: Record<string, { status: string; message?: string }>;
        timestamp: string;
      };
      const statuses: HealthStatus[] = Object.entries(healthJson.checks).map(
        ([service, check]) => ({
          service: service.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          status: check.status as HealthStatus["status"],
          message: check.message,
          lastChecked: healthJson.timestamp,
        })
      );
      setHealthStatuses(statuses);

      const containersJson = (await containersRes.json()) as ApiResponse<ContainerInfo[]>;
      setContainers(containersJson.data ?? []);

      const sysJson = (await sysRes.json()) as ApiResponse<SystemHealth>;
      setSystemHealth(sysJson.data ?? null);

      // Container Insights - fetch separately to avoid blocking other data
      try {
        const [cwRes, cwTsRes, tdRes] = await Promise.all([
          fetch("/api/container-metrics?action=current"),
          fetch("/api/container-metrics?action=timeseries&hours=6"),
          fetch("/api/container-metrics?action=taskdef"),
        ]);
        if (cwRes.ok) {
          const cwJson = (await cwRes.json()) as ApiResponse<ContainerMetrics>;
          setCwMetrics(cwJson.data ?? null);
        }
        if (cwTsRes.ok) {
          const cwTsJson = (await cwTsRes.json()) as ApiResponse<MetricsTimeSeries>;
          setCwTimeSeries(cwTsJson.data ?? null);
        }
        if (tdRes.ok) {
          const tdJson = (await tdRes.json()) as ApiResponse<TaskDefMetrics[]>;
          setTaskDefMetrics(tdJson.data ?? []);
        }
      } catch (cwErr) {
        console.error("Container Insights fetch failed:", cwErr);
      }

      setLastRefresh(new Date());
    } catch (err) {
      console.error("Failed to fetch monitoring data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const runningContainers = containers.filter((c) => c.status === "RUNNING");
  const pendingContainers = containers.filter(
    (c) => c.status === "PENDING" || c.status === "PROVISIONING"
  );

  // Resource insights
  const osCounts = { ubuntu: 0, al2023: 0 };
  const tierCounts = { light: 0, standard: 0, power: 0 };
  let totalCpu = 0;
  let totalMem = 0;
  for (const c of runningContainers) {
    osCounts[c.containerOs] = (osCounts[c.containerOs] ?? 0) + 1;
    tierCounts[c.resourceTier] = (tierCounts[c.resourceTier] ?? 0) + 1;
    totalCpu += parseInt(c.cpu) || 0;
    totalMem += parseInt(c.memory) || 0;
  }

  const healthyServices = healthStatuses.filter((h) => h.status === "healthy").length;
  const totalServices = healthStatuses.length;

  const handleStopContainer = async (taskArn: string) => {
    if (!confirm("Are you sure you want to stop this container?")) return;
    try {
      await fetch("/api/containers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskArn }),
      });
      void fetchData();
    } catch (err) {
      console.error("Failed to stop container:", err);
    }
  };

  if (loading && containers.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-500">Loading monitoring data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Quick Status Bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${healthyServices === totalServices ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
            <span className="text-sm text-gray-300">
              {healthyServices}/{totalServices} {t("monitoring.servicesHealthy")}
            </span>
          </div>
          <span className="text-gray-700">|</span>
          <span className="text-sm text-gray-400">
            {runningContainers.length} {t("monitoring.containersRunning")}
          </span>
          {lastRefresh && (
            <>
              <span className="text-gray-700">|</span>
              <span className="text-xs text-gray-600">
                Updated {lastRefresh.toLocaleTimeString()}
              </span>
            </>
          )}
        </div>
        <button
          onClick={() => void fetchData()}
          className="px-3 py-1.5 text-xs font-medium text-gray-300 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Filters */}
      {containers.length > 0 && (
        <FilterBar
          searchPlaceholder={locale === "ko" ? "사용자, 컨테이너 검색..." : "Search users, containers..."}
          searchValue={searchText}
          onSearchChange={setSearchText}
          filters={[
            {
              key: "user",
              label: locale === "ko" ? "사용자" : "User",
              value: filterUser,
              onChange: setFilterUser,
              options: [
                { value: "all", label: locale === "ko" ? "전체" : "All" },
                ...[...new Set(containers.map((c) => c.username || c.subdomain).filter(Boolean))].sort().map((u) => ({ value: u, label: u })),
              ],
            },
            {
              key: "status",
              label: locale === "ko" ? "상태" : "Status",
              value: filterStatus,
              onChange: setFilterStatus,
              options: [
                { value: "all", label: locale === "ko" ? "전체" : "All", count: containers.length },
                { value: "RUNNING", label: "RUNNING", count: runningContainers.length },
                { value: "PENDING", label: "PENDING", count: pendingContainers.length },
              ],
            },
          ]}
        />
      )}

      {/* Service Health */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4">{t("monitoring.serviceHealth")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {healthStatuses.map((hs) => (
            <HealthCard key={hs.service} {...hs} />
          ))}
          {/* LiteLLM system health cards */}
          {systemHealth && (
            <>
              <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-200">LiteLLM Proxy</h3>
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
                    systemHealth.status === "healthy" ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${systemHealth.status === "healthy" ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
                    {systemHealth.status}
                  </span>
                </div>
                <p className="mt-2 text-sm text-gray-400">
                  DB: {systemHealth.db} · Cache: {systemHealth.cache} · v{systemHealth.litellm_version}
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  {systemHealth.model_count} {t("monitoring.modelsConfigured")}
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Resource Insights */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4">{t("monitoring.resourceInsights")}</h2>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard
            title={t("monitoring.running")}
            value={runningContainers.length}
            description={t("monitoring.allContainers")}
          />
          <StatCard
            title={t("monitoring.pending")}
            value={pendingContainers.length}
            description={t("monitoring.allContainers")}
          />
          <StatCard
            title={t("monitoring.totalVcpu")}
            value={totalCpu > 0 ? `${(totalCpu / 1024).toFixed(0)}` : String(runningContainers.length)}
            description={t("monitoring.allocatedCpu")}
          />
          <StatCard
            title={t("monitoring.totalMemory")}
            value={totalMem > 0 ? `${(totalMem / 1024).toFixed(1)} GiB` : "-"}
            description={t("monitoring.allocatedRam")}
          />
          <StatCard
            title={t("monitoring.allContainers")}
            value={containers.length}
            description={t("monitoring.allStates")}
          />
        </div>
      </section>

      {/* Container Distribution */}
      {runningContainers.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-100 mb-4">{t("monitoring.containerDist")}</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* OS Distribution */}
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <h3 className="text-sm font-medium text-gray-300 mb-3">{t("monitoring.osDist")}</h3>
              <div className="space-y-3">
                {Object.entries(osCounts).filter(([, v]) => v > 0).map(([os, count]) => {
                  const pct = (count / runningContainers.length) * 100;
                  return (
                    <div key={os} className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-16">{os === "al2023" ? "AL2023" : "Ubuntu"}</span>
                      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-400 w-14 text-right">{count} ({pct.toFixed(0)}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Tier Distribution */}
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <h3 className="text-sm font-medium text-gray-300 mb-3">{t("monitoring.tierDist")}</h3>
              <div className="space-y-3">
                {Object.entries(tierCounts).filter(([, v]) => v > 0).map(([tier, count]) => {
                  const pct = (count / runningContainers.length) * 100;
                  const color = tier === "light" ? "bg-gray-500" : tier === "standard" ? "bg-blue-500" : "bg-purple-500";
                  return (
                    <div key={tier} className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-16 capitalize">{tier}</span>
                      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-400 w-14 text-right">{count} ({pct.toFixed(0)}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Container Insights - Cluster Utilization */}
      {cwMetrics && (
        <section>
          <h2 className="text-lg font-semibold text-gray-100 mb-4">Container Insights</h2>

          {/* Utilization Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">CPU Utilization</p>
              <p className={`text-2xl font-bold ${cwMetrics.cpuUtilizationPct > 80 ? "text-red-400" : cwMetrics.cpuUtilizationPct > 60 ? "text-yellow-400" : "text-green-400"}`}>
                {cwMetrics.cpuUtilizationPct.toFixed(1)}%
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5">{cwMetrics.cpuUtilized.toFixed(0)} / {cwMetrics.cpuReserved.toFixed(0)} CPU units</p>
            </div>
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Memory Utilization</p>
              <p className={`text-2xl font-bold ${cwMetrics.memoryUtilizationPct > 80 ? "text-red-400" : cwMetrics.memoryUtilizationPct > 60 ? "text-yellow-400" : "text-green-400"}`}>
                {cwMetrics.memoryUtilizationPct.toFixed(1)}%
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5">{cwMetrics.memoryUtilized.toFixed(0)} / {cwMetrics.memoryReserved.toFixed(0)} MiB</p>
            </div>
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Network I/O</p>
              <p className="text-lg font-bold text-cyan-400">↓{formatBytes(cwMetrics.networkRxBytes)}</p>
              <p className="text-lg font-bold text-purple-400">↑{formatBytes(cwMetrics.networkTxBytes)}</p>
            </div>
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Storage I/O</p>
              <p className="text-lg font-bold text-blue-400">R: {formatBytes(cwMetrics.storageReadBytes)}</p>
              <p className="text-lg font-bold text-amber-400">W: {formatBytes(cwMetrics.storageWriteBytes)}</p>
            </div>
          </div>

          {/* Utilization Bars */}
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5 mb-4 space-y-4">
            <UtilizationBar label="CPU" used={cwMetrics.cpuUtilized} total={cwMetrics.cpuReserved} unit="units" color="bg-cyan-500" />
            <UtilizationBar label="Memory" used={cwMetrics.memoryUtilized} total={cwMetrics.memoryReserved} unit="MiB" color="bg-purple-500" />
          </div>

          {/* Time Series Charts */}
          {cwTimeSeries && cwTimeSeries.timestamps.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              <AreaTrendChart
                data={cwTimeSeries.timestamps.map((ts, i) => ({
                  date: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  cpu: cwTimeSeries.cpuUtilized[i] ?? 0,
                  memory: cwTimeSeries.memoryUtilized[i] ?? 0,
                }))}
                series={[
                  { key: "cpu", name: "CPU (units)", color: "#06b6d4" },
                  { key: "memory", name: "Memory (MiB)", color: "#a855f7" },
                ]}
                title="CPU & Memory (Last 6h)"
                height={220}
              />
              <AreaTrendChart
                data={cwTimeSeries.timestamps.map((ts, i) => ({
                  date: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  rx: (cwTimeSeries.networkRx[i] ?? 0) / 1024,
                  tx: (cwTimeSeries.networkTx[i] ?? 0) / 1024,
                }))}
                series={[
                  { key: "rx", name: "Network Rx (KiB)", color: "#06b6d4" },
                  { key: "tx", name: "Network Tx (KiB)", color: "#f59e0b" },
                ]}
                title="Network I/O (Last 6h)"
                height={220}
              />
            </div>
          )}

          {/* Per-TaskDef Metrics */}
          {taskDefMetrics.length > 0 && (
            <div className="bg-[#161b22] rounded-xl border border-gray-800 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800 bg-[#0a0f1a]">
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">Task Definition</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">CPU Used</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">CPU Reserved</th>
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">CPU %</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">Mem Used</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">Mem Reserved</th>
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">Mem %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {taskDefMetrics.map((td) => {
                    const cpuPct = td.cpuReserved > 0 ? (td.cpuUtilized / td.cpuReserved) * 100 : 0;
                    const memPct = td.memoryReserved > 0 ? (td.memoryUtilized / td.memoryReserved) * 100 : 0;
                    return (
                      <tr key={td.taskDefFamily} className="hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-2.5 text-sm text-gray-200 font-medium">
                          {td.taskDefFamily.replace("devenv-", "")}
                        </td>
                        <td className="px-4 py-2.5 text-right text-sm text-gray-400">{td.cpuUtilized.toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right text-sm text-gray-400">{td.cpuReserved.toFixed(0)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${cpuPct > 80 ? "bg-red-500" : "bg-cyan-500"}`} style={{ width: `${Math.min(cpuPct, 100)}%` }} />
                            </div>
                            <span className="text-[10px] text-gray-500">{cpuPct.toFixed(0)}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right text-sm text-gray-400">{td.memoryUtilized.toFixed(0)}</td>
                        <td className="px-4 py-2.5 text-right text-sm text-gray-400">{td.memoryReserved.toFixed(0)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${memPct > 80 ? "bg-red-500" : "bg-purple-500"}`} style={{ width: `${Math.min(memPct, 100)}%` }} />
                            </div>
                            <span className="text-[10px] text-gray-500">{memPct.toFixed(0)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Active Sessions */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4">{t("monitoring.activeSessions")}</h2>
        <ContainersTable
          containers={containers.filter((c) => {
            if (filterUser !== "all" && (c.username || c.subdomain) !== filterUser) return false;
            if (filterStatus !== "all" && c.status !== filterStatus) return false;
            if (searchText && !(c.username || "").toLowerCase().includes(searchText.toLowerCase()) && !(c.subdomain || "").toLowerCase().includes(searchText.toLowerCase())) return false;
            return true;
          })}
          onStop={handleStopContainer}
          domainName={domainName}
          devSubdomain={devSubdomain}
        />
      </section>
    </div>
  );
}
