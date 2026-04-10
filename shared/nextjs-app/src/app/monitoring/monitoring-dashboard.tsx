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
  architecture: string;
  model_count: number;
}

interface Ec2Metrics {
  avgCpu: number;
  avgMemory: number;
  totalNetworkRx: number;
  totalNetworkTx: number;
  instanceCount: number;
}

interface Ec2TimeSeries {
  timestamps: string[];
  cpu: number[];
  memory: number[];
  networkRx: number[];
  networkTx: number[];
}

interface InstanceMetricsRow {
  instanceId: string;
  subdomain: string;
  username: string;
  instanceType: string;
  cpu: number;
  memory: number;
  networkRx: number;
  networkTx: number;
}

interface BedrockMetricsSnapshot {
  inputTokensPerMin: number;
  outputTokensPerMin: number;
  totalTokensPerMin: number;
  invocationsPerMin: number;
  avgLatencyMs: number;
  estimatedCostPerMin: number;
}

interface BedrockTsData {
  timestamps: string[];
  inputTokens: number[];
  outputTokens: number[];
  invocations: number[];
  estimatedCost: number[];
}

// EC2 on-demand pricing (ap-northeast-2, Seoul)
const EC2_PRICING: Record<string, number> = {
  "m7g.4xlarge": 0.8208,  // 16 vCPU, 64 GiB
  "m7g.2xlarge": 0.4104,  // 8 vCPU, 32 GiB
  "t4g.xlarge": 0.1792,   // 4 vCPU, 16 GiB
};
const CLUSTER_INSTANCE_TYPE = "m7g.4xlarge";
const DASHBOARD_INSTANCE_TYPE = "t4g.xlarge";

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
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
  domainName = "atomai.click",
  devSubdomain = "dev",
}: MonitoringDashboardProps) {
  const { t, locale } = useI18n();
  const [healthStatuses, setHealthStatuses] = useState<HealthStatus[]>([]);
  const [filterUser, setFilterUser] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDept, setFilterDept] = useState("all");
  const [filterTier, setFilterTier] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [ec2Metrics, setEc2Metrics] = useState<Ec2Metrics | null>(null);
  const [ec2TimeSeries, setEc2TimeSeries] = useState<Ec2TimeSeries | null>(null);
  const [instanceMetrics, setInstanceMetrics] = useState<InstanceMetricsRow[]>([]);
  const [bedrockMetrics, setBedrockMetrics] = useState<BedrockMetricsSnapshot | null>(null);
  const [bedrockTimeSeries, setBedrockTimeSeries] = useState<BedrockTsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [healthRes, containersRes, sysRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/containers"),
        fetch("/api/usage?action=system_health"),
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

      // EC2 Instance Metrics - fetch separately to avoid blocking other data
      try {
        const [ec2Res, ec2TsRes, instRes] = await Promise.all([
          fetch("/api/container-metrics?action=current"),
          fetch("/api/container-metrics?action=timeseries&hours=6"),
          fetch("/api/container-metrics?action=instances"),
        ]);
        if (ec2Res.ok) {
          const ec2Json = (await ec2Res.json()) as ApiResponse<Ec2Metrics>;
          setEc2Metrics(ec2Json.data ?? null);
        }
        if (ec2TsRes.ok) {
          const ec2TsJson = (await ec2TsRes.json()) as ApiResponse<Ec2TimeSeries>;
          setEc2TimeSeries(ec2TsJson.data ?? null);
        }
        if (instRes.ok) {
          const instJson = (await instRes.json()) as ApiResponse<InstanceMetricsRow[]>;
          setInstanceMetrics(instJson.data ?? []);
        }
      } catch (ec2Err) {
        console.error("EC2 metrics fetch failed:", ec2Err);
      }

      // Bedrock Usage metrics
      try {
        const [brRes, brTsRes] = await Promise.all([
          fetch("/api/container-metrics?action=bedrock"),
          fetch("/api/container-metrics?action=bedrock_timeseries&hours=6"),
        ]);
        if (brRes.ok) {
          const brJson = (await brRes.json()) as ApiResponse<BedrockMetricsSnapshot>;
          setBedrockMetrics(brJson.data ?? null);
        }
        if (brTsRes.ok) {
          const brTsJson = (await brTsRes.json()) as ApiResponse<BedrockTsData>;
          setBedrockTimeSeries(brTsJson.data ?? null);
        }
      } catch (brErr) {
        console.error("Bedrock metrics fetch failed:", brErr);
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
    if (!confirm("Are you sure you want to stop this instance?")) return;
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
          searchPlaceholder={locale === "ko" ? "사용자, 인스턴스 검색..." : "Search users, instances..."}
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
            {
              key: "dept",
              label: locale === "ko" ? "부서" : "Department",
              value: filterDept,
              onChange: setFilterDept,
              options: [
                { value: "all", label: locale === "ko" ? "전체" : "All" },
                ...[...new Set(containers.map((c) => c.department).filter((d): d is string => !!d))].sort().map((d) => ({ value: d, label: d })),
              ],
            },
            {
              key: "tier",
              label: locale === "ko" ? "사이즈" : "Tier",
              value: filterTier,
              onChange: setFilterTier,
              options: [
                { value: "all", label: locale === "ko" ? "전체" : "All" },
                { value: "light", label: "Light", count: containers.filter((c) => c.resourceTier === "light").length },
                { value: "standard", label: "Standard", count: containers.filter((c) => c.resourceTier === "standard").length },
                { value: "power", label: "Power", count: containers.filter((c) => c.resourceTier === "power").length },
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
          {/* Bedrock system health cards */}
          {systemHealth && (
            <>
              <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-200">Bedrock API</h3>
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
                    systemHealth.status === "healthy" ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${systemHealth.status === "healthy" ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
                    {systemHealth.status}
                  </span>
                </div>
                <p className="mt-2 text-sm text-gray-400">
                  Usage: {systemHealth.db} · Architecture: {systemHealth.architecture ?? "Direct Bedrock"}
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  {systemHealth.model_count} {t("monitoring.modelsConfigured")}
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Bedrock Usage */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4">Bedrock Usage</h2>

        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Tokens / min</p>
            <p className="text-2xl font-bold text-emerald-400">
              {bedrockMetrics ? formatNumber(bedrockMetrics.totalTokensPerMin) : "-"}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              {bedrockMetrics ? `In ${formatNumber(bedrockMetrics.inputTokensPerMin)} · Out ${formatNumber(bedrockMetrics.outputTokensPerMin)}` : "No data"}
            </p>
          </div>
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Invocations / min</p>
            <p className="text-2xl font-bold text-blue-400">
              {bedrockMetrics ? bedrockMetrics.invocationsPerMin.toFixed(1) : "-"}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">Bedrock API calls</p>
          </div>
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Avg Latency</p>
            <p className="text-2xl font-bold text-amber-400">
              {bedrockMetrics && bedrockMetrics.avgLatencyMs > 0 ? `${(bedrockMetrics.avgLatencyMs / 1000).toFixed(1)}s` : "-"}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">Response time</p>
          </div>
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Bedrock Cost / hr</p>
            <p className="text-2xl font-bold text-rose-400">
              {bedrockMetrics ? `$${(bedrockMetrics.estimatedCostPerMin * 60).toFixed(2)}` : "-"}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">Token usage cost</p>
          </div>
        </div>

        {/* Infrastructure Cost Breakdown */}
        {(() => {
          const devCount = ec2Metrics?.instanceCount ?? 0;
          const devCostHr = devCount * (EC2_PRICING[CLUSTER_INSTANCE_TYPE] ?? 0);
          const dashCostHr = EC2_PRICING[DASHBOARD_INSTANCE_TYPE] ?? 0;
          const bedrockCostHr = (bedrockMetrics?.estimatedCostPerMin ?? 0) * 60;
          const totalCostHr = bedrockCostHr + devCostHr + dashCostHr;
          return (
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-300">Infrastructure Cost / hr</h3>
                <span className="text-lg font-bold text-white">${totalCostHr.toFixed(2)}/hr</span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Bedrock API</p>
                  <p className="text-sm font-semibold text-rose-400">${bedrockCostHr.toFixed(2)}</p>
                  <p className="text-[10px] text-gray-600">Token usage</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Dev Instances</p>
                  <p className="text-sm font-semibold text-cyan-400">${devCostHr.toFixed(2)}</p>
                  <p className="text-[10px] text-gray-600">{devCount}× {CLUSTER_INSTANCE_TYPE}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Dashboard EC2</p>
                  <p className="text-sm font-semibold text-purple-400">${dashCostHr.toFixed(2)}</p>
                  <p className="text-[10px] text-gray-600">1× {DASHBOARD_INSTANCE_TYPE}</p>
                </div>
              </div>
              {/* Cost bar */}
              <div className="mt-3 h-2 bg-gray-800 rounded-full overflow-hidden flex">
                {totalCostHr > 0 && (
                  <>
                    <div className="h-full bg-rose-500" style={{ width: `${(bedrockCostHr / totalCostHr) * 100}%` }} />
                    <div className="h-full bg-cyan-500" style={{ width: `${(devCostHr / totalCostHr) * 100}%` }} />
                    <div className="h-full bg-purple-500" style={{ width: `${(dashCostHr / totalCostHr) * 100}%` }} />
                  </>
                )}
              </div>
              <div className="flex gap-4 mt-1.5">
                <span className="text-[10px] text-gray-600 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" />Bedrock</span>
                <span className="text-[10px] text-gray-600 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan-500 inline-block" />Dev EC2</span>
                <span className="text-[10px] text-gray-600 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />Dashboard</span>
              </div>
            </div>
          );
        })()}

        {/* Time Series Charts */}
        {bedrockTimeSeries && bedrockTimeSeries.timestamps.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AreaTrendChart
              data={bedrockTimeSeries.timestamps.map((ts, i) => ({
                date: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                input: bedrockTimeSeries.inputTokens[i] ?? 0,
                output: bedrockTimeSeries.outputTokens[i] ?? 0,
              }))}
              series={[
                { key: "input", name: "Input Tokens/min", color: "#34d399" },
                { key: "output", name: "Output Tokens/min", color: "#f472b6" },
              ]}
              title="Token Throughput (Last 6h)"
              height={220}
            />
            <AreaTrendChart
              data={bedrockTimeSeries.timestamps.map((ts, i) => ({
                date: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                cost: (bedrockTimeSeries.estimatedCost[i] ?? 0) * 60,
              }))}
              series={[
                { key: "cost", name: "Bedrock Cost $/hr", color: "#fb7185" },
              ]}
              title="Bedrock Cost Trend (Last 6h)"
              height={220}
            />
          </div>
        )}
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

      {/* Instance Metrics - EC2 Utilization */}
      {ec2Metrics && (
        <section>
          <h2 className="text-lg font-semibold text-gray-100 mb-4">Instance Metrics</h2>

          {/* Utilization Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Avg CPU</p>
              <p className={`text-2xl font-bold ${ec2Metrics.avgCpu > 80 ? "text-red-400" : ec2Metrics.avgCpu > 60 ? "text-yellow-400" : "text-green-400"}`}>
                {ec2Metrics.avgCpu.toFixed(1)}%
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5">{ec2Metrics.instanceCount} instances</p>
            </div>
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Avg Memory</p>
              <p className={`text-2xl font-bold ${ec2Metrics.avgMemory > 80 ? "text-red-400" : ec2Metrics.avgMemory > 60 ? "text-yellow-400" : "text-green-400"}`}>
                {ec2Metrics.avgMemory.toFixed(1)}%
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5">CWAgent mem_used_percent</p>
            </div>
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Network I/O</p>
              <p className="text-lg font-bold text-cyan-400">↓{formatBytes(ec2Metrics.totalNetworkRx)}</p>
              <p className="text-lg font-bold text-purple-400">↑{formatBytes(ec2Metrics.totalNetworkTx)}</p>
            </div>
            <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Instances</p>
              <p className="text-2xl font-bold text-blue-400">{ec2Metrics.instanceCount}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">Running dev envs</p>
            </div>
          </div>

          {/* Utilization Bars */}
          <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5 mb-4 space-y-4">
            <UtilizationBar label="CPU" used={ec2Metrics.avgCpu} total={100} unit="%" color="bg-cyan-500" />
            <UtilizationBar label="Memory" used={ec2Metrics.avgMemory} total={100} unit="%" color="bg-purple-500" />
          </div>

          {/* Time Series Charts */}
          {ec2TimeSeries && ec2TimeSeries.timestamps.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              <AreaTrendChart
                data={ec2TimeSeries.timestamps.map((ts, i) => ({
                  date: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  cpu: ec2TimeSeries.cpu[i] ?? 0,
                  memory: ec2TimeSeries.memory[i] ?? 0,
                }))}
                series={[
                  { key: "cpu", name: "CPU %", color: "#06b6d4" },
                  { key: "memory", name: "Memory %", color: "#a855f7" },
                ]}
                title="CPU & Memory (Last 6h)"
                height={220}
              />
              <AreaTrendChart
                data={ec2TimeSeries.timestamps.map((ts, i) => ({
                  date: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  rx: (ec2TimeSeries.networkRx[i] ?? 0) / 1024,
                  tx: (ec2TimeSeries.networkTx[i] ?? 0) / 1024,
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

          {/* Per-Instance Metrics */}
          {instanceMetrics.length > 0 && (
            <div className="bg-[#161b22] rounded-xl border border-gray-800 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800 bg-[#0a0f1a]">
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">User</th>
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">Instance Type</th>
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">CPU %</th>
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">Memory %</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">Net Rx</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-medium text-gray-500 uppercase">Net Tx</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {instanceMetrics.map((inst) => (
                    <tr key={inst.instanceId} className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-2.5 text-sm text-gray-200 font-medium">
                        {inst.username || inst.subdomain}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-400">{inst.instanceType}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${inst.cpu > 80 ? "bg-red-500" : "bg-cyan-500"}`} style={{ width: `${Math.min(inst.cpu, 100)}%` }} />
                          </div>
                          <span className="text-[10px] text-gray-500">{inst.cpu.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${inst.memory > 80 ? "bg-red-500" : "bg-purple-500"}`} style={{ width: `${Math.min(inst.memory, 100)}%` }} />
                          </div>
                          <span className="text-[10px] text-gray-500">{inst.memory.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-sm text-gray-400">{formatBytes(inst.networkRx)}</td>
                      <td className="px-4 py-2.5 text-right text-sm text-gray-400">{formatBytes(inst.networkTx)}</td>
                    </tr>
                  ))}
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
            if (filterDept !== "all" && c.department !== filterDept) return false;
            if (filterTier !== "all" && c.resourceTier !== filterTier) return false;
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
