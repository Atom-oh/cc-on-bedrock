"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useDeploymentMode } from "@/components/deployment-mode-provider";
import type { DepartmentBudgetState } from "@/lib/approval-authz";
import {
  APPROVAL_ERRORS,
  MAX_INCREASE_USD,
  approvalNotice,
  formatLimitValue,
  budgetRequestGate,
  errorKey,
  fill,
  isExpiredRequest,
  isRequestTypeVisible,
  type TokenReleaseResult,
} from "@/lib/budget-ui";
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
  Wallet,
  History,
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
  statements?: string;
  llmNote?: string;
  reason?: string;
  resourceTier?: string;
  // budget_increase
  requesterRole?: string;
  period?: string;
  periodKey?: string;
  requestedAmount?: number;
  approvedAmount?: number;
  snapshotSpend?: number;
  snapshotBudget?: number;
  rejectReason?: string;
  // limit_change (applied audit record)
  actor?: string;
  actorRole?: string;
  targetType?: string;
  before?: Record<string, number>;
  after?: Record<string, number>;
  appliedAt?: string;
}

/** Department state for the budget_increase cap pre-check and the department-deny hint. */
interface DeptState extends DepartmentBudgetState {
  /** Spend reached the department total: budget-check denies every member. */
  over: boolean;
}

interface Notice {
  tone: "ok" | "warn" | "error";
  lines: string[];
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
  budget_increase: { label: "Budget Increase", icon: Wallet, color: "text-emerald-400" },
  limit_change: { label: "Limit Change", icon: History, color: "text-sky-400" },
};

// Instance-permission requests (tier, DLP, container, IAM extension) belong to the devEnv
// edition only; governance mode shows budget_increase (and limit_change history) only.
const FILTERS = ["pending", "approved", "rejected", "", "history"] as const;
type Filter = (typeof FILTERS)[number];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  rejected: "bg-red-500/10 text-red-400 border-red-500/20",
  expired: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

const usd = (n: number | undefined) => `$${(n ?? 0).toFixed(2)}`;

export default function ApprovalsPage() {
  const { t } = useI18n();
  const mode = useDeploymentMode();
  const devenv = mode === "devenv";
  const { data: session } = useSession();
  const viewer = { email: session?.user?.email ?? "", isAdmin: session?.user?.isAdmin ?? false };
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [policyCatalog, setPolicyCatalog] = useState<PolicySetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [depts, setDepts] = useState<Record<string, DeptState>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      // limit_change audit records are stored as status "applied".
      const status = filter === "history" ? "applied" : filter;
      const url = status ? `/api/admin/approval-requests?status=${status}` : "/api/admin/approval-requests";
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        const list = (data.data as ApprovalRequest[]).filter((r) => isRequestTypeVisible(r.type, mode));
        setRequests(filter === "history"
          ? list.filter((r) => r.type === "limit_change")
          : list.filter((r) => r.type !== "limit_change"));
        if (data.meta?.policySetCatalog) setPolicyCatalog(data.meta.policySetCatalog);
      }
    } catch (err) {
      console.error("Failed to fetch requests:", err);
    } finally {
      setLoading(false);
    }
  }, [filter, mode]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // Department totals: a dept-manager's cap pre-check (/api/dept) and, for both roles,
  // the hint that a department-total deny is not lifted by a personal grant.
  const fetchDepts = useCallback(async () => {
    if (!session?.user) return;
    try {
      if (session.user.isAdmin) {
        const res = await fetch("/api/admin/budgets?type=department");
        const json = await res.json();
        const out: Record<string, DeptState> = {};
        for (const d of (json.data?.departments ?? []) as Array<{ department: string; monthlyBudget: number; currentSpend: number }>) {
          out[d.department] = {
            monthlyBudget: d.monthlyBudget,
            monthSpend: d.currentSpend,
            monthGranted: 0,
            over: d.monthlyBudget > 0 && d.currentSpend >= d.monthlyBudget,
          };
        }
        setDepts(out);
      } else {
        const res = await fetch("/api/dept");
        const json = await res.json();
        const b = json.data?.budget as
          | { department: string; monthlyBudget: number; recordedSpend?: number; monthGranted?: number }
          | null
          | undefined;
        if (b?.department) {
          const spend = b.recordedSpend ?? 0;
          setDepts({
            [b.department]: {
              monthlyBudget: b.monthlyBudget,
              monthSpend: spend,
              monthGranted: b.monthGranted ?? 0,
              over: b.monthlyBudget > 0 && spend >= b.monthlyBudget,
            },
          });
        }
      }
    } catch (err) {
      console.error("Failed to fetch department budgets:", err);
    }
  }, [session?.user]);

  useEffect(() => { void fetchDepts(); }, [fetchDepts]);

  const requestAmount = (req: ApprovalRequest) => {
    const raw = amounts[req.requestId];
    return raw === undefined ? req.requestedAmount ?? 0 : Number(raw);
  };

  async function handleAction(req: ApprovalRequest, action: "approve" | "reject") {
    const requestId = req.requestId;
    const isBudget = req.type === "budget_increase";
    setProcessing(requestId);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { requestId, action };
      if (isBudget && action === "approve") body.amount = requestAmount(req);
      if (isBudget && action === "reject" && rejectReasons[requestId]?.trim()) body.reason = rejectReasons[requestId].trim();
      const res = await fetch("/api/admin/approval-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        if (data.data?.alreadyProcessed) {
          setNotice({ tone: "warn", lines: [t("approvals.error.already_decided")] });
        } else if (action === "reject") {
          setNotice({ tone: "ok", lines: [fill(t("approvals.rejected"), { email: req.email })] });
        } else if (isBudget) {
          const applied = data.data?.applied as
            | { releaseEtaMinutes?: number; tokenRelease?: TokenReleaseResult }
            | undefined;
          setNotice(approvalNotice({
            email: req.email,
            amount: requestAmount(req),
            releaseEtaMinutes: applied?.releaseEtaMinutes,
            tokenRelease: applied?.tokenRelease,
            departmentOver: !!depts[req.department]?.over,
          }, t));
        } else {
          setNotice({ tone: "ok", lines: [fill(t("approvals.applied"), { email: req.email })] });
        }
        await fetchRequests();
        void fetchDepts();
        // Sidebar pending badge listens for this.
        window.dispatchEvent(new Event("approvals:changed"));
      } else {
        const key = errorKey("approvals.error", data.error, APPROVAL_ERRORS);
        const text = key.endsWith(".unknown") && data.error ? `${t(key)} (${data.error})` : t(key);
        setNotice({ tone: "error", lines: [text] });
      }
    } catch (err) {
      setNotice({ tone: "error", lines: [`${t("approvals.error.unknown")} (${err})`] });
    } finally {
      setProcessing(null);
    }
  }

  function getPolicyName(id: string): string {
    return policyCatalog.find(p => p.id === id)?.name ?? id;
  }

  function renderTypeDetails(req: ApprovalRequest) {
    if (req.type === "budget_increase") {
      return (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-400">{t(`budgetIncrease.period.${req.period}`)}</span>
          <span className="text-gray-600 font-mono text-xs">{req.periodKey} UTC</span>
          <span className="text-white font-bold">+{usd(req.approvedAmount ?? req.requestedAmount)}</span>
        </div>
      );
    }
    if (req.type === "limit_change") {
      return (
        <span className="text-gray-400 text-sm">
          {req.targetType === "department" ? req.department : req.email}
        </span>
      );
    }
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
      // ADR-026: prefer free-form statements (action+resource); fall back to legacy policySets.
      let parsed: Array<{ Action: string[]; Resource: string[] }> = [];
      if (req.statements) {
        try { parsed = JSON.parse(req.statements); } catch { parsed = []; }
      }
      return (
        <div className="flex flex-col gap-1.5">
          {parsed.length > 0 ? (
            <div className="flex flex-col gap-1">
              {parsed.map((s, i) => (
                <div key={i} className="text-[11px] font-mono text-gray-300">
                  <span className="text-purple-400">{(s.Action ?? []).join(", ")}</span>
                  <span className="text-gray-500"> on </span>
                  <span className="text-gray-400">{(s.Resource ?? []).join(", ")}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {(req.policySets ?? []).map(ps => (
                <span key={ps} className="px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 text-[10px] font-bold border border-purple-500/20">
                  {getPolicyName(ps)}
                </span>
              ))}
            </div>
          )}
          {req.llmNote && (
            <div className="rounded border border-amber-500/20 bg-amber-500/5 p-2 text-[11px] text-amber-200/90">
              <span className="font-bold text-amber-400">AI review (advisory):</span> {req.llmNote}
            </div>
          )}
        </div>
      );
    }
    return <span className="text-gray-500 text-sm">Tier: {req.resourceTier ?? "standard"}</span>;
  }

  /** Budget increase detail: snapshot, approver amount, reject reason and why buttons are off. */
  function renderBudgetPanel(req: ApprovalRequest) {
    const amount = requestAmount(req);
    const dept = depts[req.department];
    const gate = budgetRequestGate(req, viewer, amount, viewer.isAdmin ? null : dept ?? null, new Date());
    const amountValid = Number.isFinite(amount) && amount > 0 && amount <= MAX_INCREASE_USD;
    const pending = req.status === "pending";
    return {
      canApprove: pending && gate === "actionable" && amountValid,
      canReject: pending && gate === "actionable",
      body: (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-gray-600 uppercase tracking-widest text-[10px]">{t("approvals.field.period")}</span>
              <p className="text-white font-bold mt-0.5">{t(`budgetIncrease.period.${req.period}`)} · {req.periodKey} (UTC)</p>
            </div>
            <div>
              <span className="text-gray-600 uppercase tracking-widest text-[10px]">{t("approvals.field.requested")}</span>
              <p className="text-white font-bold mt-0.5">{usd(req.requestedAmount)}</p>
            </div>
            <div>
              <span className="text-gray-600 uppercase tracking-widest text-[10px]">{t("approvals.field.snapshot")}</span>
              <p className="text-white font-bold mt-0.5">{usd(req.snapshotSpend)} / {usd(req.snapshotBudget)}</p>
            </div>
            {req.approvedAmount !== undefined && (
              <div>
                <span className="text-gray-600 uppercase tracking-widest text-[10px]">{t("approvals.field.approvedAmount")}</span>
                <p className="text-white font-bold mt-0.5">{usd(req.approvedAmount)}</p>
              </div>
            )}
          </div>

          {req.rejectReason && (
            <div className="bg-[#0d1117] rounded-xl p-3 border border-white/5">
              <span className="text-[10px] text-gray-600 uppercase tracking-widest">{t("approvals.field.rejectReason")}</span>
              <p className="text-sm text-gray-300 mt-1">{req.rejectReason}</p>
            </div>
          )}

          {dept?.over && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
              {t("approvals.deptOverHint")}{" "}
              {viewer.isAdmin && (
                <Link href="/admin/budgets" className="underline text-amber-300">{t("approvals.deptOverLink")}</Link>
              )}
            </div>
          )}

          {pending && gate !== "actionable" && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-gray-300">
              {t(`approvals.gate.${gate}`)}
            </div>
          )}

          {pending && gate === "actionable" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor={`amt-${req.requestId}`} className="text-[10px] text-gray-600 uppercase tracking-widest">
                  {t("approvals.field.adjustAmount")}
                </label>
                <input
                  id={`amt-${req.requestId}`}
                  type="number"
                  min={0.01}
                  max={MAX_INCREASE_USD}
                  step="0.01"
                  value={amounts[req.requestId] ?? String(req.requestedAmount ?? "")}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setAmounts((a) => ({ ...a, [req.requestId]: e.target.value }))}
                  className="mt-1 w-full px-3 py-2 text-sm bg-[#0d1117] border border-white/10 text-gray-200 rounded-lg"
                />
                {!amountValid && <p className="mt-1 text-[11px] text-red-400">{t("approvals.error.invalid_amount")}</p>}
              </div>
              <div>
                <label htmlFor={`rr-${req.requestId}`} className="text-[10px] text-gray-600 uppercase tracking-widest">
                  {t("approvals.field.rejectReasonInput")}
                </label>
                <input
                  id={`rr-${req.requestId}`}
                  type="text"
                  maxLength={500}
                  value={rejectReasons[req.requestId] ?? ""}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRejectReasons((r) => ({ ...r, [req.requestId]: e.target.value }))}
                  className="mt-1 w-full px-3 py-2 text-sm bg-[#0d1117] border border-white/10 text-gray-200 rounded-lg"
                />
              </div>
            </div>
          )}
        </div>
      ),
    };
  }

  function renderHistory() {
    if (requests.length === 0) {
      return (
        <div className="text-center py-16 text-gray-500">
          <History className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t("approvals.historyEmpty")}</p>
        </div>
      );
    }
    return (
      <div className="overflow-x-auto bg-[#161b22]/60 rounded-2xl border border-white/5 p-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] text-gray-500 uppercase tracking-widest border-b border-white/5">
              <th className="pb-2 font-bold">{t("approvals.history.time")}</th>
              <th className="pb-2 font-bold">{t("approvals.history.actor")}</th>
              <th className="pb-2 font-bold">{t("approvals.history.target")}</th>
              <th className="pb-2 font-bold">{t("approvals.history.change")}</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => {
              const fields = [...new Set([...Object.keys(r.before ?? {}), ...Object.keys(r.after ?? {})])];
              return (
                <tr key={r.requestId} className="border-b border-white/5 align-top">
                  <td className="py-2 text-gray-400 text-xs">{new Date(r.appliedAt ?? r.requestedAt).toLocaleString()}</td>
                  <td className="py-2 text-gray-200">
                    {r.actor}
                    {r.actorRole && <span className="ml-1 text-[10px] text-gray-500">({r.actorRole})</span>}
                  </td>
                  <td className="py-2 text-gray-200">
                    {r.targetType === "department" ? `${t("approvals.history.department")}: ${r.department}` : r.email}
                  </td>
                  <td className="py-2 text-xs font-mono">
                    {fields.map((f) => (
                      <div key={f}>
                        <span className="text-gray-500">{f}</span>{" "}
                        <span className="text-gray-400">{formatLimitValue(f, r.before?.[f])}</span>
                        <span className="text-gray-600"> → </span>
                        <span className="text-white">{formatLimitValue(f, r.after?.[f])}</span>
                      </div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
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
          <h1 className="text-2xl font-black text-white tracking-tight">{t("approvals.title")}</h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">
            {viewer.isAdmin
              ? devenv ? t("approvals.subtitle.devenv") : t("approvals.subtitle.governance")
              : t("approvals.subtitle.manager")}
          </p>
        </div>
        <button
          onClick={fetchRequests}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#161b22] border border-white/5 text-gray-300 hover:text-white text-xs font-bold"
        >
          <RefreshCw className="w-3.5 h-3.5" /> {t("common.refresh")}
        </button>
      </div>

      {notice && (
        <div
          role="status"
          className={cn(
            "rounded-xl border p-4 text-sm space-y-1",
            notice.tone === "ok" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
            notice.tone === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-200",
            notice.tone === "error" && "border-red-500/30 bg-red-500/10 text-red-300",
          )}
        >
          {notice.lines.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2">
        {FILTERS.map(f => (
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
            {t(`approvals.filter.${f || "all"}`)}
          </button>
        ))}
      </div>

      {/* Request list */}
      {filter === "history" ? renderHistory() : requests.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Clock className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t("approvals.empty")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map(req => {
            const typeInfo = TYPE_LABELS[req.type] ?? TYPE_LABELS.container_request;
            const TypeIcon = typeInfo.icon;
            const isExpanded = expandedId === req.requestId;
            const isBudget = req.type === "budget_increase";
            const budget = isBudget ? renderBudgetPanel(req) : null;
            // Computed at read time: a pending request whose UTC window ended shows as expired.
            const shownStatus = isExpiredRequest(req, new Date()) ? "expired" : req.status;
            const canApprove = budget ? budget.canApprove : req.email.toLowerCase() !== viewer.email.toLowerCase();
            const canReject = budget ? budget.canReject : canApprove;

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
                          STATUS_STYLES[shownStatus] ?? "bg-gray-500/10 text-gray-400"
                        )}>
                          {t(`approvals.status.${shownStatus}`)}
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
                      {!isBudget && (
                        <div>
                          <span className="text-gray-600 uppercase tracking-widest text-[10px]">Subdomain</span>
                          <p className="text-white font-bold mt-0.5">{req.subdomain || "—"}</p>
                        </div>
                      )}
                      <div>
                        <span className="text-gray-600 uppercase tracking-widest text-[10px]">{t("approvals.field.department")}</span>
                        <p className="text-white font-bold mt-0.5">{req.department || "—"}</p>
                      </div>
                      <div>
                        <span className="text-gray-600 uppercase tracking-widest text-[10px]">{t("approvals.field.requestedAt")}</span>
                        <p className="text-white font-bold mt-0.5">{new Date(req.requestedAt).toLocaleString()}</p>
                      </div>
                      {(req.approvedBy || req.rejectedBy) && (
                        <div>
                          <span className="text-gray-600 uppercase tracking-widest text-[10px]">
                            {req.status === "rejected" ? t("approvals.field.rejectedBy") : t("approvals.field.approvedBy")}
                          </span>
                          <p className="text-white font-bold mt-0.5">{req.approvedBy ?? req.rejectedBy}</p>
                        </div>
                      )}
                    </div>

                    {req.reason && (
                      <div className="bg-[#0d1117] rounded-xl p-3 border border-white/5">
                        <span className="text-[10px] text-gray-600 uppercase tracking-widest">{t("approvals.field.reason")}</span>
                        <p className="text-sm text-gray-300 mt-1">{req.reason}</p>
                      </div>
                    )}

                    {budget?.body}

                    {req.status === "pending" && (
                      <div className="flex gap-3 pt-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAction(req, "approve"); }}
                          disabled={!!processing || !canApprove}
                          className="flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 text-xs font-black uppercase tracking-widest disabled:opacity-50"
                        >
                          <CheckCircle className="w-3.5 h-3.5" />
                          {processing === req.requestId ? t("approvals.applying") : t("approvals.approve")}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAction(req, "reject"); }}
                          disabled={!!processing || !canReject}
                          className="flex items-center gap-2 px-5 py-2 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 text-xs font-black uppercase tracking-widest disabled:opacity-50"
                        >
                          <XCircle className="w-3.5 h-3.5" /> {t("approvals.reject")}
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
