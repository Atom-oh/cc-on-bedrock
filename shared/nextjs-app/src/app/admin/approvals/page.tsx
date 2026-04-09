"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  Cpu,
  Key,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface ApprovalRequest {
  requestId: string;
  type: string;
  email: string;
  subdomain: string;
  department: string;
  status: string;
  requestedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  newTier?: string;
  currentTier?: string;
  newPolicy?: string;
  currentPolicy?: string;
  policySets?: string[];
  reason?: string;
  resourceTier?: string;
}

interface PolicySetInfo {
  id: string;
  name: string;
  description: string;
}

const TYPE_LABELS: Record<string, { label: string; icon: typeof Cpu; color: string }> = {
  tier_change: { label: "Tier Change", icon: Cpu, color: "text-blue-400" },
  dlp_change: { label: "DLP Change", icon: Shield, color: "text-amber-400" },
  iam_extension: { label: "IAM Extension", icon: Key, color: "text-purple-400" },
  container_request: { label: "Container Request", icon: Cpu, color: "text-gray-400" },
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  rejected: "bg-red-500/10 text-red-400 border-red-500/20",
};

export default function ApprovalsPage() {
  const { t } = useI18n();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [policyCatalog, setPolicyCatalog] = useState<PolicySetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("pending");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      const url = filter ? `/api/admin/approval-requests?status=${filter}` : "/api/admin/approval-requests";
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setRequests(data.data);
        if (data.meta?.policySetCatalog) setPolicyCatalog(data.meta.policySetCatalog);
      }
    } catch (err) {
      console.error("Failed to fetch requests:", err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  async function handleAction(requestId: string, action: "approve" | "reject") {
    setProcessing(requestId);
    try {
      const res = await fetch("/api/admin/approval-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, action }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchRequests();
      } else {
        alert(`Failed: ${data.error}`);
      }
    } catch (err) {
      alert(`Error: ${err}`);
    } finally {
      setProcessing(null);
    }
  }

  function getPolicyName(id: string): string {
    return policyCatalog.find(p => p.id === id)?.name ?? id;
  }

  function renderTypeDetails(req: ApprovalRequest) {
    if (req.type === "tier_change") {
      return (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">{req.currentTier}</span>
          <span className="text-gray-600">→</span>
          <span className="text-white font-bold">{req.newTier}</span>
        </div>
      );
    }
    if (req.type === "dlp_change") {
      return (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">{req.currentPolicy}</span>
          <span className="text-gray-600">→</span>
          <span className="text-white font-bold">{req.newPolicy}</span>
        </div>
      );
    }
    if (req.type === "iam_extension") {
      return (
        <div className="flex flex-wrap gap-1">
          {(req.policySets ?? []).map(ps => (
            <span key={ps} className="px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 text-[10px] font-bold border border-purple-500/20">
              {getPolicyName(ps)}
            </span>
          ))}
        </div>
      );
    }
    return <span className="text-gray-500 text-sm">Tier: {req.resourceTier ?? "standard"}</span>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="w-8 h-8 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1200px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-white tracking-tight">Approval Requests</h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">
            Manage tier, DLP, and IAM change requests
          </p>
        </div>
        <button
          onClick={fetchRequests}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#161b22] border border-white/5 text-gray-300 hover:text-white text-xs font-bold"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {["pending", "approved", "rejected", ""].map(f => (
          <button
            key={f || "all"}
            onClick={() => { setFilter(f); setLoading(true); }}
            className={cn(
              "px-4 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all",
              filter === f
                ? "bg-primary-500/20 text-primary-400 border border-primary-500/30"
                : "bg-[#161b22] text-gray-500 border border-white/5 hover:text-gray-300"
            )}
          >
            {f || "All"}
          </button>
        ))}
      </div>

      {/* Request list */}
      {requests.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Clock className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No {filter || ""} requests</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map(req => {
            const typeInfo = TYPE_LABELS[req.type] ?? TYPE_LABELS.container_request;
            const TypeIcon = typeInfo.icon;
            const isExpanded = expandedId === req.requestId;

            return (
              <div
                key={req.requestId}
                className="bg-[#161b22]/60 backdrop-blur-md rounded-2xl border border-white/5 overflow-hidden"
              >
                <div
                  className="flex items-center justify-between p-5 cursor-pointer hover:bg-white/[0.02] transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : req.requestId)}
                >
                  <div className="flex items-center gap-4">
                    <div className={cn("p-2 rounded-lg bg-white/5", typeInfo.color)}>
                      <TypeIcon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white">{req.email}</span>
                        <span className={cn(
                          "px-2 py-0.5 rounded-full text-[10px] font-black border",
                          STATUS_STYLES[req.status] ?? "bg-gray-500/10 text-gray-400"
                        )}>
                          {req.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className={cn("text-[10px] font-bold uppercase tracking-widest", typeInfo.color)}>
                          {typeInfo.label}
                        </span>
                        {renderTypeDetails(req)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-gray-600">
                      {new Date(req.requestedAt).toLocaleDateString()}
                    </span>
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-600" /> : <ChevronDown className="w-4 h-4 text-gray-600" />}
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-5 pb-5 border-t border-white/5 pt-4 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                      <div>
                        <span className="text-gray-600 uppercase tracking-widest text-[10px]">Subdomain</span>
                        <p className="text-white font-bold mt-0.5">{req.subdomain || "—"}</p>
                      </div>
                      <div>
                        <span className="text-gray-600 uppercase tracking-widest text-[10px]">Department</span>
                        <p className="text-white font-bold mt-0.5">{req.department}</p>
                      </div>
                      <div>
                        <span className="text-gray-600 uppercase tracking-widest text-[10px]">Requested</span>
                        <p className="text-white font-bold mt-0.5">{new Date(req.requestedAt).toLocaleString()}</p>
                      </div>
                      {req.approvedBy && (
                        <div>
                          <span className="text-gray-600 uppercase tracking-widest text-[10px]">
                            {req.status === "rejected" ? "Rejected By" : "Approved By"}
                          </span>
                          <p className="text-white font-bold mt-0.5">{req.approvedBy ?? req.rejectedBy}</p>
                        </div>
                      )}
                    </div>

                    {req.reason && (
                      <div className="bg-[#0d1117] rounded-xl p-3 border border-white/5">
                        <span className="text-[10px] text-gray-600 uppercase tracking-widest">Reason</span>
                        <p className="text-sm text-gray-300 mt-1">{req.reason}</p>
                      </div>
                    )}

                    {req.status === "pending" && (
                      <div className="flex gap-3 pt-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAction(req.requestId, "approve"); }}
                          disabled={!!processing}
                          className="flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 text-xs font-black uppercase tracking-widest disabled:opacity-50"
                        >
                          <CheckCircle className="w-3.5 h-3.5" />
                          {processing === req.requestId ? "Applying..." : "Approve & Apply"}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAction(req.requestId, "reject"); }}
                          disabled={!!processing}
                          className="flex items-center gap-2 px-5 py-2 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 text-xs font-black uppercase tracking-widest disabled:opacity-50"
                        >
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
