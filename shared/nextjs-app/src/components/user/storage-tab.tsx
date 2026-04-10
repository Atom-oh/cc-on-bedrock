"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { UserSession, ContainerInfo, DiskUsage, EbsResizeData } from "@/lib/types";

interface StorageTabProps {
  user: UserSession;
  container: ContainerInfo | null;
}

export default function StorageTab({ user, container }: StorageTabProps) {
  const [diskUsage, setDiskUsage] = useState<DiskUsage | null>(null);
  const [resizeData, setResizeData] = useState<EbsResizeData | null>(null);
  const [diskLoading, setDiskLoading] = useState(false);
  const [resizeLoading, setResizeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // EBS resize form state
  const [requestedSize, setRequestedSize] = useState<number>(40);
  const [reason, setReason] = useState("");
  const [submitLoading, setSubmitLoading] = useState(false);

  // AI Resource Review state
  const [aiReview, setAiReview] = useState<{ analysis: string; verdict: { recommended: boolean; actions: string[] } } | null>(null);
  const [aiReviewLoading, setAiReviewLoading] = useState(false);
  const [showReviewResult, setShowReviewResult] = useState(false);

  const isEbs = user.storageType === "ebs";
  const isRunning = container?.status === "RUNNING";

  const fetchDiskUsage = useCallback(async () => {
    if (!isRunning) return;
    setDiskLoading(true);
    try {
      const res = await fetch("/api/user/disk-usage");
      if (res.ok) {
        const data = await res.json();
        if (data.success) setDiskUsage(data.data);
      }
    } catch { /* ignore */ }
    finally { setDiskLoading(false); }
  }, [isRunning]);

  const fetchResizeStatus = useCallback(async () => {
    if (!isEbs) return;
    setResizeLoading(true);
    try {
      const res = await fetch("/api/user/ebs-resize");
      if (res.ok) {
        const data = await res.json();
        if (data.success) setResizeData(data.data);
      }
    } catch { /* ignore */ }
    finally { setResizeLoading(false); }
  }, [isEbs]);

  useEffect(() => {
    fetchDiskUsage();
    fetchResizeStatus();
    const interval = setInterval(() => {
      fetchDiskUsage();
      fetchResizeStatus();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchDiskUsage, fetchResizeStatus]);

  // Step 1: AI reviews the request before submission
  const handleRequestReview = async () => {
    setAiReviewLoading(true);
    setAiReview(null);
    setShowReviewResult(false);
    setError(null);
    try {
      const res = await fetch("/api/user/resource-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewType: "ebs_resize", requestedValue: String(requestedSize), reason: reason.trim() }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        setAiReview(data.data);
        setShowReviewResult(true);
      } else {
        // AI review failed — skip to direct submit
        await handleSubmitResize();
      }
    } catch {
      // AI unavailable — skip to direct submit
      await handleSubmitResize();
    } finally {
      setAiReviewLoading(false);
    }
  };

  // Step 2: Actually submit the resize request
  const handleSubmitResize = async () => {
    setSubmitLoading(true);
    setError(null);
    setSuccess(null);
    setShowReviewResult(false);
    setAiReview(null);
    try {
      const res = await fetch("/api/user/ebs-resize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedSizeGb: requestedSize, reason: reason.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess("Resize request submitted successfully");
        setReason("");
        await fetchResizeStatus();
      } else {
        setError(data.error ?? "Failed to submit resize request");
      }
    } catch {
      setError("Failed to submit resize request");
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleCancelResize = async () => {
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/user/ebs-resize", { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setSuccess("Resize request cancelled");
        await fetchResizeStatus();
      } else {
        setError(data.error ?? "Failed to cancel request");
      }
    } catch {
      setError("Failed to cancel request");
    }
  };

  const [autoKeepAlive, setAutoKeepAlive] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("cc-auto-keep-alive") === "true";
    }
    return false;
  });
  const autoKeepAliveRef = useRef(autoKeepAlive);
  autoKeepAliveRef.current = autoKeepAlive;

  const handleKeepAlive = async () => {
    try {
      const res = await fetch("/api/user/keep-alive", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setSuccess("Keep-alive extended by 1 hour");
      } else {
        setError(data.error ?? "Failed to extend keep-alive");
      }
    } catch {
      setError("Failed to extend keep-alive");
    }
  };

  // Auto keep-alive: extend every 30 minutes when toggle is on
  useEffect(() => {
    if (!autoKeepAlive || !container || container.status === "STOPPED") return;
    // Extend immediately on enable
    fetch("/api/user/keep-alive", { method: "POST" }).catch(() => {});
    const interval = setInterval(() => {
      if (autoKeepAliveRef.current) {
        fetch("/api/user/keep-alive", { method: "POST" }).catch(() => {});
      }
    }, 30 * 60 * 1000); // 30 minutes
    return () => clearInterval(interval);
  }, [autoKeepAlive, container]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-900/30 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg" role="alert" aria-live="polite">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-900/30 border border-green-500/30 text-green-400 px-4 py-3 rounded-lg" role="status" aria-live="polite">
          {success}
        </div>
      )}

      {/* Disk Usage */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-semibold text-gray-100 mb-4">Disk Usage</h2>

        {!isRunning ? (
          <p className="text-sm text-gray-500">Instance must be running to view disk usage.</p>
        ) : diskLoading && !diskUsage ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
            Loading disk usage...
          </div>
        ) : diskUsage ? (
          <div>
            {isEbs ? (
              <>
                {/* EBS: Gauge with total/used */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">Storage Used</span>
                  <span className="text-sm text-gray-300">
                    {formatBytes(diskUsage.used)} / {formatBytes(diskUsage.total)}
                  </span>
                </div>
                <div
                  className="w-full h-4 bg-gray-800 rounded-full overflow-hidden mb-1"
                  role="progressbar"
                  aria-valuenow={diskUsage.usagePercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Disk usage"
                >
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      diskUsage.usagePercent >= 90
                        ? "bg-red-500"
                        : diskUsage.usagePercent >= 80
                        ? "bg-yellow-500"
                        : "bg-blue-500"
                    }`}
                    style={{ width: `${diskUsage.usagePercent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500">{diskUsage.usagePercent}% used</p>
                  {diskUsage.usagePercent >= 80 && (
                    <p className="text-xs text-yellow-400 font-medium">
                      {diskUsage.usagePercent >= 90 ? "Critical — consider expanding" : "Warning — disk is getting full"}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* EFS: Usage only (no limit) */}
                <div className="bg-[#0d1117] rounded-lg p-4">
                  <p className="text-xs text-gray-500 mb-1">Current Usage</p>
                  <p className="text-2xl font-bold text-gray-100">{formatBytes(diskUsage.used)}</p>
                  <p className="text-xs text-green-400 mt-1">EFS — auto-scaling, no capacity limit</p>
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Unable to retrieve disk usage.</p>
        )}
      </div>

      {/* EBS Resize (EBS mode only) */}
      {isEbs && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
          <h2 className="text-lg font-semibold text-gray-100 mb-4">EBS Volume Expansion</h2>

          {/* Current resize request status */}
          {resizeData?.resizeRequest && (
            <div className={`rounded-lg p-4 mb-4 ${
              resizeData.resizeRequest.status === "resize_pending"
                ? "bg-yellow-900/20 border border-yellow-800/30"
                : resizeData.resizeRequest.status === "approved"
                ? "bg-green-900/20 border border-green-800/30"
                : resizeData.resizeRequest.status === "rejected"
                ? "bg-red-900/20 border border-red-800/30"
                : "bg-gray-800/50 border border-gray-700"
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-200">Pending Request</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  resizeData.resizeRequest.status === "resize_pending"
                    ? "bg-yellow-900/50 text-yellow-400"
                    : resizeData.resizeRequest.status === "approved"
                    ? "bg-green-900/50 text-green-400"
                    : "bg-red-900/50 text-red-400"
                }`}>
                  {resizeData.resizeRequest.status.replace("_", " ")}
                </span>
              </div>
              <p className="text-xs text-gray-400">
                Requested: {resizeData.resizeRequest.requestedSizeGb} GB — {resizeData.resizeRequest.reason}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Submitted: {new Date(resizeData.resizeRequest.requestedAt).toLocaleString()}
              </p>
              {resizeData.resizeRequest.status === "resize_pending" && (
                <button
                  onClick={handleCancelResize}
                  className="mt-2 text-xs text-red-400 hover:text-red-300 underline"
                >
                  Cancel Request
                </button>
              )}
            </div>
          )}

          {/* Resize form (only when no pending request) */}
          {!resizeData?.resizeRequest || resizeData.resizeRequest.status !== "resize_pending" ? (
            <div>
              <div className="mb-3">
                <p className="text-xs text-gray-500 mb-1">Current Size</p>
                <p className="text-sm text-gray-200 font-medium">{resizeData?.currentSizeGb ?? 20} GB</p>
              </div>

              <div className="mb-3">
                <label className="block text-xs text-gray-500 mb-2">Requested Size</label>
                <div className="flex flex-wrap gap-2">
                  {[40, 60, 100].map((size) => (
                    <button
                      key={size}
                      onClick={() => setRequestedSize(size)}
                      disabled={size <= (resizeData?.currentSizeGb ?? 20)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                        requestedSize === size && size > (resizeData?.currentSizeGb ?? 20)
                          ? "bg-blue-600 text-white"
                          : size <= (resizeData?.currentSizeGb ?? 20)
                          ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                          : "bg-[#0d1117] text-gray-300 border border-gray-700 hover:border-gray-600"
                      }`}
                    >
                      {size} GB
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-4">
                <label htmlFor="resize-reason" className="block text-xs text-gray-500 mb-2">Reason (min 10 chars)</label>
                <textarea
                  id="resize-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Describe why you need more disk space..."
                  className="w-full bg-[#0d1117] border border-gray-700 rounded-lg p-3 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none resize-none"
                  rows={3}
                />
                <p className={`text-xs mt-1 ${reason.trim().length >= 10 ? "text-gray-500" : "text-yellow-400"}`}>
                  {reason.trim().length}/10 characters
                </p>
              </div>

              <button
                onClick={handleRequestReview}
                disabled={aiReviewLoading || submitLoading || reason.trim().length < 10 || requestedSize <= (resizeData?.currentSizeGb ?? 20)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
              >
                {aiReviewLoading ? (
                  <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>AI Reviewing...</>
                ) : submitLoading ? "Submitting..." : "AI Review & Request"}
              </button>

              {/* AI Review Result Panel */}
              {showReviewResult && aiReview && (
                <div className={`mt-4 p-4 rounded-lg border ${aiReview.verdict.recommended ? "bg-green-900/20 border-green-800" : "bg-yellow-900/20 border-yellow-800"}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-lg ${aiReview.verdict.recommended ? "text-green-400" : "text-yellow-400"}`}>
                      {aiReview.verdict.recommended ? "✅" : "💡"}
                    </span>
                    <span className={`text-sm font-bold ${aiReview.verdict.recommended ? "text-green-400" : "text-yellow-400"}`}>
                      {aiReview.verdict.recommended ? "Expansion Recommended" : "Optimization Suggested"}
                    </span>
                  </div>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap mb-3">{aiReview.analysis}</p>
                  {aiReview.verdict.actions.length > 0 && (
                    <ul className="text-xs text-gray-400 space-y-1 mb-3">
                      {aiReview.verdict.actions.map((a, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="text-blue-400 mt-0.5">→</span>{a}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={handleSubmitResize}
                      disabled={submitLoading}
                      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                        aiReview.verdict.recommended
                          ? "bg-green-600 hover:bg-green-700 text-white"
                          : "bg-gray-700 hover:bg-gray-600 text-gray-200"
                      }`}
                    >
                      {submitLoading ? "Submitting..." : aiReview.verdict.recommended ? "Proceed with Request" : "Request Anyway"}
                    </button>
                    <button
                      onClick={() => { setShowReviewResult(false); setAiReview(null); }}
                      className="px-3 py-1.5 text-sm font-medium text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* Keep-Alive (EBS mode only) */}
      {isEbs && isRunning && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-100">Keep-Alive</h2>
              <p className="text-xs text-gray-500 mt-1">
                Extend idle timeout by 1 hour to prevent automatic instance stop.
              </p>
            </div>
            <button
              onClick={handleKeepAlive}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Extend 1 Hour
            </button>
          </div>
          <div className="flex items-center justify-between border-t border-gray-800 pt-4">
            <div>
              <p className="text-sm font-medium text-gray-200">Auto Keep-Alive</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Automatically extend every 30 minutes while instance is running.
              </p>
            </div>
            <button
              onClick={() => {
                const next = !autoKeepAlive;
                setAutoKeepAlive(next);
                localStorage.setItem("cc-auto-keep-alive", String(next));
                if (next) setSuccess("Auto keep-alive enabled");
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                autoKeepAlive ? "bg-green-600" : "bg-gray-600"
              }`}
              role="switch"
              aria-checked={autoKeepAlive}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoKeepAlive ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
