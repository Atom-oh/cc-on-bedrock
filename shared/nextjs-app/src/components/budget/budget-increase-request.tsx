"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { BUDGET_PERIODS, type BudgetPeriod } from "@/lib/budget-periods";
import type { BlockCause } from "@/lib/budget-display";
import {
  INCREASE_REQUEST_ERRORS,
  MAX_INCREASE_USD,
  MAX_REASON_LENGTH,
  errorKey,
  fill,
  isExpiredRequest,
  nearLimit,
  validIncreaseForm,
} from "@/lib/budget-ui";

// One-time budget increase (spec §5.1): the caller's USD caps as "base + grant", why
// they are blocked, a request form, and their own request history. Works in both
// deployment modes. Pass `limits` from an existing /api/local/limits fetch to avoid a
// second call; omit it and the panel fetches on its own.

export interface UsdPeriod {
  period: BudgetPeriod;
  spend: number;
  base: number;
  grant: number;
  cap: number;
}

export interface BudgetLimits {
  usdPeriods?: UsdPeriod[];
  blockCause?: BlockCause;
}

interface IncreaseRequest {
  requestId: string;
  period: BudgetPeriod;
  periodKey: string;
  requestedAmount: number;
  approvedAmount?: number;
  reason?: string;
  status: string;
  requestedAt?: string;
  approvedBy?: string;
  rejectedBy?: string;
  rejectReason?: string;
}

const TONES = {
  dark: {
    box: "border border-gray-800 rounded p-4 bg-gray-900/50",
    title: "text-gray-200",
    text: "text-gray-300",
    muted: "text-gray-500",
    input: "bg-[#0d1117] border border-gray-700 text-gray-200",
    row: "border-gray-800",
    red: "border-red-500/40 bg-red-500/10 text-red-300",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  },
  light: {
    box: "border rounded p-4 bg-white",
    title: "text-gray-900",
    text: "text-gray-700",
    muted: "text-gray-500",
    input: "bg-white border border-gray-300 text-gray-900",
    row: "border-gray-200",
    red: "border-red-300 bg-red-50 text-red-700",
    amber: "border-amber-300 bg-amber-50 text-amber-800",
    green: "border-emerald-300 bg-emerald-50 text-emerald-800",
  },
} as const;

const usd = (n: number) => `$${n.toFixed(2)}`;

export default function BudgetIncreaseRequest({
  limits,
  tone = "dark",
}: {
  limits?: BudgetLimits | null;
  tone?: keyof typeof TONES;
}) {
  const { t } = useI18n();
  const c = TONES[tone];
  const [ownLimits, setOwnLimits] = useState<BudgetLimits | null>(null);
  const [history, setHistory] = useState<IncreaseRequest[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [period, setPeriod] = useState<BudgetPeriod | "">("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const selfFetch = limits === undefined;
  const view = selfFetch ? ownLimits : limits;

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/user/budget-increase", { cache: "no-store" });
      const j = await r.json();
      if (j.success) setHistory(j.data?.requests ?? []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    if (!selfFetch) return;
    (async () => {
      try {
        const r = await fetch("/api/local/limits", { cache: "no-store" });
        if (r.ok) setOwnLimits(await r.json());
      } catch (e) {
        console.error(e);
      }
    })();
  }, [loadHistory, selfFetch]);

  const periods = view?.usdPeriods ?? [];
  const capped = periods.filter((p) => p.cap > 0);
  const cause = view?.blockCause ?? null;
  const near = periods.filter((p) => nearLimit(p.spend, p.cap));
  const periodLabel = (p: string) => t(`budgetIncrease.period.${p}`);

  // Default to the blocked period, else the first capped one.
  useEffect(() => {
    if (period || capped.length === 0) return;
    const blocked = cause?.startsWith("user_") ? (cause.slice(5) as BudgetPeriod) : undefined;
    setPeriod(blocked && capped.some((p) => p.period === blocked) ? blocked : capped[0].period);
  }, [capped, cause, period]);

  // Open the form when blocked by something a personal grant can lift.
  useEffect(() => {
    if (cause && cause !== "department") setFormOpen(true);
  }, [cause]);

  const submit = async () => {
    if (!period || !validIncreaseForm(amount, reason)) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const r = await fetch("/api/user/budget-increase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, requestedAmount: Number(amount), reason: reason.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.success) {
        setMessage({ ok: true, text: t("budgetIncrease.submitted") });
        setAmount("");
        setReason("");
        void loadHistory();
      } else {
        setMessage({ ok: false, text: t(errorKey("budgetIncrease.error", j.error, INCREASE_REQUEST_ERRORS)) });
      }
    } catch {
      setMessage({ ok: false, text: t("budgetIncrease.error.unknown") });
    } finally {
      setSubmitting(false);
    }
  };

  const statusText = (r: IncreaseRequest) => {
    if (r.status === "approved") {
      return fill(t("budgetIncrease.status.approvedAmount"), { amount: usd(r.approvedAmount ?? r.requestedAmount) });
    }
    if (r.status === "rejected") {
      return r.rejectReason
        ? `${t("budgetIncrease.status.rejected")} — ${r.rejectReason}`
        : t("budgetIncrease.status.rejected");
    }
    // A pending request whose UTC window has ended can no longer be approved.
    if (r.status === "pending" && isExpiredRequest({ ...r, type: "budget_increase", email: "" }, new Date())) {
      return t("budgetIncrease.status.expired");
    }
    return t(`budgetIncrease.status.${r.status}`);
  };

  return (
    <section className={c.box}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className={`text-base font-medium ${c.title}`}>{t("budgetIncrease.title")}</h3>
        <button
          onClick={() => setFormOpen((v) => !v)}
          disabled={capped.length === 0}
          className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium disabled:opacity-50"
        >
          {t("budgetIncrease.requestButton")}
        </button>
      </div>

      {/* Block cause / near-limit status */}
      {cause === "department" && (
        <div className={`rounded border p-3 text-sm mb-3 ${c.red}`}>{t("budgetIncrease.cause.department")}</div>
      )}
      {cause?.startsWith("user_") && (
        <div className={`rounded border p-3 text-sm mb-3 ${c.red}`}>
          {fill(t("budgetIncrease.cause.user"), { period: periodLabel(cause.slice(5)) })}
        </div>
      )}
      {cause === "token" && (
        <div className={`rounded border p-3 text-sm mb-3 ${c.red}`}>{t("budgetIncrease.cause.token")}</div>
      )}
      {!cause && near.length > 0 && (
        <div className={`rounded border p-3 text-sm mb-3 ${c.amber}`}>
          {fill(t("budgetIncrease.near"), { periods: near.map((p) => periodLabel(p.period)).join(", ") })}
        </div>
      )}

      {/* USD caps: base + current one-time grant */}
      {periods.length > 0 && (
        <div className={`grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs mb-1 ${c.text}`}>
          {periods.map((p) => (
            <div key={p.period}>
              <span className={`uppercase tracking-wide ${c.muted}`}>{periodLabel(p.period)}</span>{" "}
              {p.cap > 0 ? `${usd(p.spend)} / ${usd(p.cap)}` : `${usd(p.spend)} / ${t("budgetIncrease.unlimited")}`}
              {p.grant > 0 && (
                <div className={c.muted}>
                  {fill(t("budgetIncrease.basePlusGrant"), { base: usd(p.base), grant: usd(p.grant) })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className={`text-xs mb-3 ${c.muted}`}>{t("budgetIncrease.utcNote")}</p>

      {capped.length === 0 && periods.length > 0 && (
        <p className={`text-sm mb-3 ${c.muted}`}>{t("budgetIncrease.allUnlimited")}</p>
      )}

      {formOpen && capped.length > 0 && (
        <div className={`space-y-3 border-t pt-3 mb-3 ${c.row}`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="bi-period" className={`block text-xs mb-1 ${c.muted}`}>{t("budgetIncrease.field.period")}</label>
              <select
                id="bi-period"
                value={period}
                onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
                className={`w-full px-2 py-2 text-sm rounded ${c.input}`}
              >
                {BUDGET_PERIODS.map((p) => {
                  const unlimited = !capped.some((x) => x.period === p);
                  return (
                    <option key={p} value={p} disabled={unlimited}>
                      {periodLabel(p)}{unlimited ? ` (${t("budgetIncrease.unlimited")})` : ""}
                    </option>
                  );
                })}
              </select>
            </div>
            <div>
              <label htmlFor="bi-amount" className={`block text-xs mb-1 ${c.muted}`}>{t("budgetIncrease.field.amount")}</label>
              <input
                id="bi-amount"
                type="number"
                min={1}
                max={MAX_INCREASE_USD}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`w-full px-2 py-2 text-sm rounded ${c.input}`}
                placeholder="20"
              />
            </div>
          </div>
          <div>
            <label htmlFor="bi-reason" className={`block text-xs mb-1 ${c.muted}`}>{t("budgetIncrease.field.reason")}</label>
            <textarea
              id="bi-reason"
              value={reason}
              maxLength={MAX_REASON_LENGTH}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className={`w-full px-2 py-2 text-sm rounded ${c.input}`}
            />
            <div className={`text-right text-[10px] ${c.muted}`}>{reason.trim().length}/{MAX_REASON_LENGTH}</div>
          </div>
          <p className={`text-xs ${c.muted}`}>{t("budgetIncrease.oneTimeNote")}</p>
          <button
            onClick={() => void submit()}
            disabled={submitting || !period || !validIncreaseForm(amount, reason)}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50"
          >
            {submitting ? t("budgetIncrease.submitting") : t("budgetIncrease.submit")}
          </button>
        </div>
      )}

      {message && (
        <div className={`rounded border p-2 text-sm mb-3 ${message.ok ? c.green : c.red}`}>{message.text}</div>
      )}

      {/* Own request history */}
      <div className={`border-t pt-3 ${c.row}`}>
        <h4 className={`text-sm font-medium mb-2 ${c.title}`}>{t("budgetIncrease.history")}</h4>
        {history.length === 0 ? (
          <p className={`text-xs ${c.muted}`}>{t("budgetIncrease.historyEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={`w-full text-xs ${c.text}`}>
              <thead>
                <tr className={`text-left border-b ${c.row} ${c.muted}`}>
                  <th className="pb-1 font-medium">{t("budgetIncrease.col.requested")}</th>
                  <th className="pb-1 font-medium">{t("budgetIncrease.field.period")}</th>
                  <th className="pb-1 font-medium text-right">{t("budgetIncrease.field.amount")}</th>
                  <th className="pb-1 font-medium">{t("budgetIncrease.col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.requestId} className={`border-b ${c.row}`}>
                    <td className="py-1">{r.requestedAt ? new Date(r.requestedAt).toLocaleString() : "—"}</td>
                    <td className="py-1">{periodLabel(r.period)} <span className={c.muted}>({r.periodKey} UTC)</span></td>
                    <td className="py-1 text-right">{usd(r.requestedAmount)}</td>
                    <td className="py-1">{statusText(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
