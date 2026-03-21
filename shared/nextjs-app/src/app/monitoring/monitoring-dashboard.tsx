"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import HealthCard from "@/components/cards/health-card";
import StatCard from "@/components/cards/stat-card";
import ContainersTable from "@/components/tables/containers-table";
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

export default function MonitoringDashboard({
  domainName = "example.com",
  devSubdomain = "dev",
}: MonitoringDashboardProps) {
  const { t } = useI18n();
  const [healthStatuses, setHealthStatuses] = useState<HealthStatus[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
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

      {/* Active Sessions */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4">{t("monitoring.activeSessions")}</h2>
        <ContainersTable
          containers={containers}
          onStop={handleStopContainer}
          domainName={domainName}
          devSubdomain={devSubdomain}
        />
      </section>
    </div>
  );
}
