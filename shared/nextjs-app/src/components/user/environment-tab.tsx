"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import type { UserSession, ContainerInfo } from "@/lib/types";
import { TIER_CONFIG } from "@/lib/types";
import ContainerMetrics from "@/components/container-metrics";
import ProvisioningProgress from "./provisioning-progress";
import { emailToSubdomain } from "@/lib/utils";

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

  // Container request state (for users without subdomain)
  const [requestStatus, setRequestStatus] = useState<"none" | "pending" | "approved" | "loading">("loading");
  // Verified subdomain from Cognito (bypasses stale JWT)
  const [verifiedSubdomain, setVerifiedSubdomain] = useState<string | null | undefined>(undefined); // undefined = not yet checked
  const [requestTier, setRequestTier] = useState<"light" | "standard" | "power">("standard");
  const [requestStorage, setRequestStorage] = useState<"ebs" | "efs">("ebs");
  const [requestVolumeSize, setRequestVolumeSize] = useState(20);
  const [requestSubmitting, setRequestSubmitting] = useState(false);

  const domainName = process.env.NEXT_PUBLIC_DOMAIN_NAME ?? "atomai.click";
  const devSubdomain = process.env.NEXT_PUBLIC_DEV_SUBDOMAIN ?? "dev";

  // Use Cognito-verified subdomain when available, fall back to JWT value during initial load
  const effectiveSubdomain = verifiedSubdomain !== undefined ? verifiedSubdomain : (user.subdomain ?? null);
  const hasSubdomain = !!effectiveSubdomain;

  const devenvBaseUrl = effectiveSubdomain
    ? `https://${effectiveSubdomain}.${devSubdomain}.${domainName}`
    : null;
  const codeServerUrl = devenvBaseUrl ? `${devenvBaseUrl}/?folder=/home/coder` : null;
  const frontendUrl = devenvBaseUrl;  // root → port 3000
  const apiUrl = devenvBaseUrl ? `${devenvBaseUrl}/api/` : null;  // /api/ → port 8000

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
        const deptRes = await fetch("/api/user/container?action=dept-policy");
        if (deptRes.ok) {
          const deptData = await deptRes.json();
          if (deptData.success && deptData.data?.allowedTiers) {
            setDeptPolicy({ allowedTiers: deptData.data.allowedTiers });
          }
        }
      } catch { /* ignore */ }
    };

    fetchUsage();
    fetchDeptPolicy();
    const interval = setInterval(fetchUsage, 30000);
    return () => clearInterval(interval);
  }, []);

  // Verify actual subdomain from Cognito (bypasses stale JWT)
  // Then fetch container request status if subdomain is empty
  useEffect(() => {
    (async () => {
      // Step 1: Verify subdomain against Cognito
      let actualSubdomain = user.subdomain ?? null;
      try {
        const verifyRes = await fetch("/api/user/container?action=verify");
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json();
          if (verifyData.success) {
            actualSubdomain = verifyData.data?.subdomain ?? null;
          }
        }
      } catch { /* fall back to JWT value */ }
      setVerifiedSubdomain(actualSubdomain);

      // Step 2: If no subdomain, fetch request status
      if (actualSubdomain) {
        setRequestStatus("none");
        return;
      }
      try {
        const res = await fetch("/api/user/container-request");
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.data) {
            setRequestStatus(data.data.status === "pending" ? "pending" : data.data.status === "approved" ? "approved" : "none");
          } else {
            setRequestStatus("none");
          }
        } else { setRequestStatus("none"); }
      } catch { setRequestStatus("none"); }
    })();
  }, [user.subdomain]);

  const handleSubmitRequest = async () => {
    setRequestSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/user/container-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceTier: requestTier, storageType: requestStorage, volumeSize: requestVolumeSize }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setRequestStatus("pending");
      } else {
        setError(data.error ?? "신청에 실패했습니다");
      }
    } catch { setError("요청 중 오류가 발생했습니다"); }
    finally { setRequestSubmitting(false); }
  };

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
    console.log("[DEBUG] handleStartContainer called, tier:", selectedTier, "allowed:", deptPolicy.allowedTiers);
    if (!deptPolicy.allowedTiers.includes(selectedTier)) {
      setError(`Tier "${selectedTier}" is not allowed for your department`);
      console.log("[DEBUG] Tier not allowed");
      return;
    }
    console.log("[DEBUG] Setting isProvisioning=true");
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

    // Immediately show STOPPING state
    setContainer({ ...container, status: "STOPPING", desiredStatus: "STOPPED" });

    try {
      const res = await fetch("/api/user/container", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", taskArn: container.taskArn }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Failed to stop instance");
        setContainer(container); // Restore original state on error
        setActionLoading(false);
        return;
      }

      // Poll until instance is fully stopped
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const check = await fetch("/api/user/container");
          const checkData = await check.json();
          if (!checkData.data || checkData.data.status === "STOPPED" || checkData.data.status === "stopped") {
            break;
          }
        } catch { /* continue polling */ }
      }

      setContainer(null);
    } catch {
      setError("Failed to stop instance");
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

      {/* Container Request Form (no subdomain assigned) */}
      {!hasSubdomain && requestStatus === "loading" && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-8 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-gray-400">신청 상태 확인 중...</p>
        </div>
      )}

      {!hasSubdomain && requestStatus === "pending" && (
        <div className="bg-[#161b22] rounded-xl border border-yellow-500/30 p-8 text-center">
          <div className="w-12 h-12 bg-yellow-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">⏳</span>
          </div>
          <h2 className="text-lg font-semibold text-gray-100 mb-2">컨테이너 신청 대기 중</h2>
          <p className="text-gray-400 text-sm">관리자 승인 후 개발 환경이 할당됩니다.</p>
        </div>
      )}

      {!hasSubdomain && requestStatus === "approved" && (
        <div className="bg-[#161b22] rounded-xl border border-green-500/30 p-8 text-center">
          <div className="w-12 h-12 bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">✅</span>
          </div>
          <h2 className="text-lg font-semibold text-gray-100 mb-2">신청이 승인되었습니다</h2>
          <p className="text-gray-400 text-sm">관리자가 리소스를 할당하면 시작 버튼이 활성화됩니다.</p>
        </div>
      )}

      {!hasSubdomain && requestStatus === "none" && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
          <h2 className="text-lg font-semibold text-gray-100 mb-4">개발 환경 신청</h2>
          <p className="text-sm text-gray-400 mb-4">리소스 크기와 스토리지를 선택하고 신청하세요. 부서 관리자 승인 후 환경이 할당됩니다.</p>
          <div className="bg-[#0d1117] rounded-lg p-3 mb-6 flex items-center gap-2">
            <span className="text-xs text-gray-500">예상 subdomain:</span>
            <code className="text-sm text-blue-400 font-mono">{emailToSubdomain(user.email)}</code>
          </div>

          <div className="mb-6">
            <label className="block text-sm text-gray-400 mb-2">리소스 크기</label>
            <div className="grid grid-cols-3 gap-3">
              {(["light", "standard", "power"] as const).map((tier) => {
                const cfg = TIER_CONFIG[tier];
                return (
                  <button key={tier} onClick={() => setRequestTier(tier)}
                    className={`p-3 rounded-lg border text-left transition-all ${requestTier === tier ? "border-blue-500 bg-blue-900/20" : "border-gray-700 bg-[#0d1117] hover:border-gray-600"}`}>
                    <p className="text-sm font-medium text-gray-200">{tier === "light" ? "Small" : tier === "standard" ? "Medium" : "Large"}</p>
                    <p className="text-xs text-gray-500">{cfg.cpu} / {cfg.memory}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-6">
            <label className="block text-sm text-gray-400 mb-2">스토리지</label>
            <div className="p-3 rounded-lg border border-blue-500 bg-blue-900/20 text-left">
              <p className="text-sm font-medium text-gray-200">EBS (Fast SSD)</p>
              <p className="text-xs text-gray-500">Stop/Start 시 데이터 보존 · 고성능 블록 스토리지</p>
            </div>
          </div>

          <div className="mb-6">
            <label className="block text-sm text-gray-400 mb-2">볼륨 크기: {requestVolumeSize}GB</label>
            <input type="range" min={20} max={100} step={10} value={requestVolumeSize}
              onChange={(e) => setRequestVolumeSize(Number(e.target.value))}
              className="w-full accent-blue-500" />
            <div className="flex justify-between text-xs text-gray-600 mt-1">
              <span>20GB</span><span>60GB</span><span>100GB</span>
            </div>
          </div>

          <button onClick={handleSubmitRequest} disabled={requestSubmitting}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg font-medium transition-colors">
            {requestSubmitting ? "신청 중..." : "개발 환경 신청"}
          </button>
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
          {container && container.status === "STOPPING" && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-yellow-900/30 text-yellow-400">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              {t("user.stopping") || "Stopping..."}
            </span>
          )}
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
            <p className="text-sm text-gray-200">{effectiveSubdomain ?? "-"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Storage</p>
            <p className="text-sm">
              <span className={user.storageType === "ebs" ? "text-blue-400" : "text-green-400"}>
                EBS
              </span>
            </p>
          </div>
        </div>

        {/* DevEnv URL Cards */}
        {container?.status === "RUNNING" && (container?.healthStatus === "HEALTHY" || container?.healthStatus === "UNKNOWN") && codeServerUrl && (
          <div className="space-y-2 mb-4">
            {/* code-server IDE */}
            <div className="bg-[#0d1117] rounded-lg p-4 flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-blue-500/15 text-blue-400 border border-blue-500/20 rounded">IDE</span>
                  <p className="text-xs text-gray-500">code-server (port 8080)</p>
                </div>
                <a href={codeServerUrl} target="_blank" rel="noopener noreferrer"
                  className="text-sm text-blue-400 hover:text-blue-300 break-all">{codeServerUrl}</a>
              </div>
              <button onClick={() => { navigator.clipboard.writeText(codeServerUrl); setUrlCopied(true); setTimeout(() => setUrlCopied(false), 2000); }}
                className="ml-3 p-2 text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-800 transition-colors"
                aria-label="Copy IDE URL">
                {urlCopied ? (
                  <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            </div>
            {/* Frontend Preview + API */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-[#0d1117] rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-green-500/15 text-green-400 border border-green-500/20 rounded">WEB</span>
                  <p className="text-xs text-gray-500">port 3000</p>
                </div>
                <a href={frontendUrl!} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-gray-400 hover:text-gray-300 break-all">{frontendUrl}</a>
              </div>
              <div className="bg-[#0d1117] rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-orange-500/15 text-orange-400 border border-orange-500/20 rounded">API</span>
                  <p className="text-xs text-gray-500">port 8000</p>
                </div>
                <a href={apiUrl!} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-gray-400 hover:text-gray-300 break-all">{apiUrl}</a>
              </div>
            </div>
          </div>
        )}

        {/* Warming up indicator */}
        {container?.status === "RUNNING" && container?.healthStatus !== "HEALTHY" && container?.healthStatus !== "UNKNOWN" && !isProvisioning && (
          <div className="bg-yellow-900/20 border border-yellow-500/30 rounded-lg p-4 mb-4 flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin flex-shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm text-yellow-400 font-medium">code-server is starting up...</p>
              <p className="text-xs text-gray-500">Usually ready within 30-60 seconds</p>
            </div>
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
              disabled={actionLoading || !hasSubdomain}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {t("user.start") || "Start Instance"}
            </button>
          )}
          {container && container.status === "STOPPING" && (
            <button
              disabled
              className="px-4 py-2 bg-yellow-600/50 text-yellow-300 text-sm font-medium rounded-lg cursor-not-allowed"
            >
              {t("user.stopping") || "Stopping..."}
            </button>
          )}
          {container && container.status !== "STOPPING" && (
            <>
              <button
                onClick={handleStopContainer}
                disabled={actionLoading}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {actionLoading ? (t("user.stopping") || "Stopping...") : (t("user.stop") || "Stop Instance")}
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
                  {t("user.openCodeServer") || "Open IDE"}
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
                memoryUsedBytes: containerMetrics.memoryUsedBytes ?? 0,
                memoryTotalBytes: containerMetrics.memoryTotalBytes ?? 0,
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
              metrics={{ cpu: 0, cpuLimit: 1, memory: 0, memoryLimit: 1, memoryUsedBytes: 0, memoryTotalBytes: 0, networkRx: 0, networkTx: 0, diskRead: 0, diskWrite: 0 }}
              timeseries={[]}
              loading={true}
            />
          )}
        </div>
      )}
    </div>
  );
}
