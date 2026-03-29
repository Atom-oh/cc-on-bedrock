"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import type { UserSession, ContainerInfo } from "@/lib/types";
import { TIER_CONFIG } from "@/lib/types";
import ContainerMetrics from "@/components/container-metrics";
import ProvisioningProgress from "./provisioning-progress";

interface EnvironmentTabProps {
  user: UserSession;
  container: ContainerInfo | null;
  setContainer: (c: ContainerInfo | null) => void;
  fetchData: () => Promise<void>;
}

interface UsageData {
  totalTokens: number;
  dailyLimit: number;
  requests: number;
  estimatedCost: number;
}

interface DeptPolicy {
  allowedTiers: ("light" | "standard" | "power")[];
}

export default function EnvironmentTab({ user, container, setContainer, fetchData }: EnvironmentTabProps) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<"light" | "standard" | "power">(
    user.resourceTier ?? "standard"
  );
  const [deptPolicy, setDeptPolicy] = useState<DeptPolicy>({
    allowedTiers: ["light", "standard", "power"],
  });
  const [isProvisioning, setIsProvisioning] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [containerMetrics, setContainerMetrics] = useState<any>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const metricsIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const domainName = process.env.NEXT_PUBLIC_DOMAIN_NAME ?? "atomai.click";
  const devSubdomain = process.env.NEXT_PUBLIC_DEV_SUBDOMAIN ?? "dev";

  const codeServerUrl = user.subdomain
    ? `https://${user.subdomain}.${devSubdomain}.${domainName}`
    : null;

  // Fetch usage data
  useEffect(() => {
    const fetchUsage = async () => {
      try {
        const today = new Date().toISOString().split("T")[0];
        const usageRes = await fetch(`/api/user/usage?date=${today}`);
        if (usageRes.ok) {
          const usageData = await usageRes.json();
          if (usageData.success) setUsage(usageData.data);
        }
      } catch { /* ignore */ }
    };

    const fetchDeptPolicy = async () => {
      try {
        const deptRes = await fetch("/api/dept");
        if (deptRes.ok) {
          const deptData = await deptRes.json();
          if (deptData.success && deptData.data?.policy?.allowedTiers) {
            setDeptPolicy({ allowedTiers: deptData.data.policy.allowedTiers });
          }
        }
      } catch { /* ignore */ }
    };

    fetchUsage();
    fetchDeptPolicy();
    const interval = setInterval(fetchUsage, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch container metrics when running
  useEffect(() => {
    if (metricsIntervalRef.current) clearInterval(metricsIntervalRef.current);
    if (!container || container.status !== "RUNNING") {
      setContainerMetrics(null);
      return;
    }
    const fetchMetrics = async () => {
      setMetricsLoading(true);
      try {
        const res = await fetch("/api/user/container-metrics");
        const json = await res.json();
        if (json.success && json.data) setContainerMetrics(json.data);
      } catch { /* ignore */ }
      finally { setMetricsLoading(false); }
    };
    fetchMetrics();
    metricsIntervalRef.current = setInterval(fetchMetrics, 30000);
    return () => { if (metricsIntervalRef.current) clearInterval(metricsIntervalRef.current); };
  }, [container?.status, container?.taskId]);

  const handleStartContainer = async () => {
    if (!deptPolicy.allowedTiers.includes(selectedTier)) {
      setError(`Tier "${selectedTier}" is not allowed for your department`);
      return;
    }
    setIsProvisioning(true);
    setError(null);
  };

  const handleProvisioningComplete = useCallback(async (url?: string) => {
    setIsProvisioning(false);
    await fetchData();
  }, [fetchData]);

  const handleProvisioningError = useCallback((errorMsg: string) => {
    setIsProvisioning(false);
    setError(errorMsg);
  }, []);

  const handleStopContainer = async () => {
    if (!container) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/user/container", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", taskArn: container.taskArn }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Failed to stop container");
      } else {
        setContainer(null);
      }
    } catch {
      setError("Failed to stop container");
    } finally {
      setActionLoading(false);
    }
  };

  const usagePercent = usage
    ? Math.min(100, Math.round((usage.totalTokens / usage.dailyLimit) * 100))
    : 0;

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-900/30 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Provisioning Progress */}
      {isProvisioning && (
        <ProvisioningProgress
          tier={selectedTier}
          os={user.containerOs ?? "ubuntu"}
          onComplete={handleProvisioningComplete}
          onError={handleProvisioningError}
        />
      )}

      {/* Container Status */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-100">
            {t("user.containerStatus") || "Container Status"}
          </h2>
          {container && container.status === "RUNNING" && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              {t("monitoring.running")}
            </span>
          )}
          {container && (container.status === "PENDING" || container.status === "PROVISIONING") && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-yellow-900/30 text-yellow-400">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              {t("monitoring.pending")}
            </span>
          )}
          {!container && !isProvisioning && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-gray-800 text-gray-400">
              {t("user.stopped") || "Stopped"}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div>
            <p className="text-xs text-gray-500 mb-1">{t("user.os") || "OS"}</p>
            <p className="text-sm text-gray-200">
              {user.containerOs === "al2023" ? "Amazon Linux 2023" : "Ubuntu 24.04"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">{t("user.tier") || "Resource Tier"}</p>
            <p className="text-sm text-gray-200 capitalize">{user.resourceTier ?? "standard"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">{t("user.subdomain") || "Subdomain"}</p>
            <p className="text-sm text-gray-200">{user.subdomain ?? "-"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Storage</p>
            <p className="text-sm">
              <span className={user.storageType === "ebs" ? "text-blue-400" : "text-green-400"}>
                {(user.storageType ?? "efs").toUpperCase()}
              </span>
            </p>
          </div>
        </div>

        {/* VSCode URL Card */}
        {container?.status === "RUNNING" && codeServerUrl && (
          <div className="bg-[#0d1117] rounded-lg p-4 mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500 mb-1">VSCode URL</p>
              <a
                href={codeServerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-400 hover:text-blue-300 break-all"
              >
                {codeServerUrl}
              </a>
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(codeServerUrl);
                setUrlCopied(true);
                setTimeout(() => setUrlCopied(false), 2000);
              }}
              className="ml-3 p-2 text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-800 transition-colors flex items-center gap-1"
              aria-label="Copy URL to clipboard"
            >
              {urlCopied ? (
                <>
                  <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-xs text-green-400">Copied!</span>
                </>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>
          </div>
        )}

        {/* Tier Selection (only when container is not running) */}
        {!container && !isProvisioning && (
          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-2">
              {t("user.selectTier") || "Select Resource Tier"}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(["light", "standard", "power"] as const).map((tier) => {
                const config = TIER_CONFIG[tier];
                const isAllowed = deptPolicy.allowedTiers.includes(tier);
                const isSelected = selectedTier === tier;
                return (
                  <button
                    key={tier}
                    onClick={() => isAllowed && setSelectedTier(tier)}
                    disabled={!isAllowed}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      isSelected
                        ? "border-blue-500 bg-blue-900/30"
                        : isAllowed
                        ? "border-gray-700 bg-[#0d1117] hover:border-gray-600"
                        : "border-gray-800 bg-gray-900/50 opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`font-medium ${isSelected ? "text-blue-400" : "text-gray-200"}`}>
                        {config.label}
                      </span>
                      <span className="text-xs text-gray-500">{config.costMultiplier}x</span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {config.cpu} / {config.memory}
                    </div>
                    {!isAllowed && (
                      <div className="text-xs text-red-400 mt-1">
                        {t("user.tierNotAllowed") || "Not allowed"}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          {!container && !isProvisioning && (
            <button
              onClick={handleStartContainer}
              disabled={actionLoading || !user.subdomain}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {t("user.start") || "Start Container"}
            </button>
          )}
          {container && (
            <>
              <button
                onClick={handleStopContainer}
                disabled={actionLoading}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {actionLoading ? (t("user.stopping") || "Stopping...") : (t("user.stop") || "Stop Container")}
              </button>
              {container.status === "RUNNING" && codeServerUrl && (
                <a
                  href={codeServerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  {t("user.openCodeServer") || "Open code-server"}
                </a>
              )}
            </>
          )}
        </div>
      </div>

      {/* Daily Usage */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-semibold text-gray-100 mb-4">
          {t("user.dailyUsage") || "Today's Usage"}
        </h2>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-400">{t("user.tokenUsage") || "Token Usage"}</span>
            <span className="text-sm text-gray-300">
              {usage ? usage.totalTokens.toLocaleString() : 0} / {usage ? usage.dailyLimit.toLocaleString() : "100,000"}
            </span>
          </div>
          <div
            className="w-full h-3 bg-gray-800 rounded-full overflow-hidden"
            role="progressbar"
            aria-valuenow={usagePercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Token usage"
          >
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                usagePercent >= 90
                  ? "bg-red-500"
                  : usagePercent >= 70
                  ? "bg-yellow-500"
                  : "bg-blue-500"
              }`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {usagePercent}% {t("user.ofDailyLimit") || "of daily limit"}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-[#0d1117] rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">{t("user.requests") || "API Requests"}</p>
            <p className="text-xl font-bold text-gray-100">{usage?.requests ?? 0}</p>
          </div>
          <div className="bg-[#0d1117] rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">{t("user.estimatedCost") || "Est. Cost"}</p>
            <p className="text-xl font-bold text-gray-100">
              ${(usage?.estimatedCost ?? 0).toFixed(4)}
            </p>
          </div>
        </div>
      </div>

      {/* Container Metrics (shown when running) */}
      {container?.status === "RUNNING" && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
          {containerMetrics ? (
            <ContainerMetrics
              metrics={{
                cpu: containerMetrics.cpu ?? 0,
                cpuLimit: containerMetrics.cpuLimit ?? 1,
                memory: containerMetrics.memory ?? 0,
                memoryLimit: containerMetrics.memoryLimit ?? 1,
                networkRx: containerMetrics.networkRx ?? 0,
                networkTx: containerMetrics.networkTx ?? 0,
                diskRead: containerMetrics.diskRead ?? 0,
                diskWrite: containerMetrics.diskWrite ?? 0,
              }}
              timeseries={containerMetrics.timeseries ?? []}
              loading={metricsLoading}
            />
          ) : (
            <ContainerMetrics
              metrics={{ cpu: 0, cpuLimit: 1, memory: 0, memoryLimit: 1, networkRx: 0, networkTx: 0, diskRead: 0, diskWrite: 0 }}
              timeseries={[]}
              loading={true}
            />
          )}
        </div>
      )}
    </div>
  );
}
