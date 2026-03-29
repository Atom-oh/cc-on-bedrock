"use client";

import { useState, useEffect, useCallback } from "react";
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

  const handleSubmitResize = async () => {
    setSubmitLoading(true);
    setError(null);
    setSuccess(null);
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
          <p className="text-sm text-gray-500">Container must be running to view disk usage.</p>
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
                onClick={handleSubmitResize}
                disabled={submitLoading || reason.trim().length < 10 || requestedSize <= (resizeData?.currentSizeGb ?? 20)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {submitLoading ? "Submitting..." : "Request Expansion"}
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Keep-Alive (EBS mode only) */}
      {isEbs && isRunning && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-100">Keep-Alive</h2>
              <p className="text-xs text-gray-500 mt-1">
                Extend idle timeout by 1 hour to prevent automatic volume detachment.
              </p>
            </div>
            <button
              onClick={handleKeepAlive}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Extend 1 Hour
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
