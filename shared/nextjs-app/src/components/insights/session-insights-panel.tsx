"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, RefreshCw, MessagesSquare } from "lucide-react";
import StatCard from "@/components/cards/stat-card";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { InsightSeverity, SessionInsightsResponse } from "@/lib/session-usage";
import { POLL_INTERVAL_MS, insightRefreshed, shouldKeepPolling } from "@/lib/session-insight-poll";

function formatCost(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(2)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

const SEVERITY_STYLE: Record<InsightSeverity, string> = {
  info: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  watch: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  action: "bg-rose-500/10 text-rose-300 border-rose-500/20",
};

function PanelHeader({ id, title, subtitle, icon: Icon, action }: {
  id?: string;
  title: string;
  subtitle: string;
  icon: typeof Sparkles;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-6 group gap-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-primary-500/10 text-primary-400 group-hover:scale-110 transition-transform duration-300">
            <Icon className="w-4 h-4" aria-hidden="true" />
          </div>
          <h2 id={id} className="text-sm font-black text-white uppercase tracking-widest leading-none">{title}</h2>
        </div>
        <p className="text-xs font-bold text-gray-500 uppercase tracking-tighter">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

export default function SessionInsightsPanel() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<SessionInsightsResponse | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [regenDone, setRegenDone] = useState(false);
  const [regenTimedOut, setRegenTimedOut] = useState(false);
  // Cleared on unmount so a pending poll stops instead of updating a dead component.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch("/api/admin/session-insights?days=7", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (body && body.enabled === false) {
        setDisabled(true);
        setData(null);
      } else {
        setData(body as SessionInsightsResponse);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const regenerate = async () => {
    setRegenerating(true);
    setRegenError(null);
    setRegenDone(false);
    setRegenTimedOut(false);
    try {
      // 202 {date, requestedAt}: the Lambda runs asynchronously (it can outlast CloudFront's
      // origin timeout), so poll GET for that date's row until it is newer than the request.
      const res = await fetch("/api/admin/session-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 202) throw new Error(typeof body.error === "string" ? body.error : String(res.status));
      const { date, requestedAt } = body as { date: string; requestedAt: string };
      const startedAt = Date.now();
      while (mounted.current) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (!mounted.current) return;
        if (!shouldKeepPolling(startedAt, Date.now())) {
          setRegenTimedOut(true);
          return;
        }
        try {
          const poll = await fetch(
            `/api/admin/session-insights?days=7&insightDate=${encodeURIComponent(date)}`,
            { cache: "no-store" },
          );
          if (!poll.ok) continue; // transient; retry until the deadline
          const next = await poll.json();
          if (next && next.enabled === false) {
            setDisabled(true);
            return;
          }
          const fresh = next as SessionInsightsResponse;
          if (insightRefreshed(fresh.insight, date, requestedAt)) {
            if (mounted.current) {
              setData(fresh);
              setRegenDone(true);
            }
            return;
          }
        } catch {
          // network blip: keep polling until the deadline
        }
      }
    } catch (e) {
      if (mounted.current) setRegenError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setRegenerating(false);
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale === "ko" ? "ko-KR" : "en-US");
  };

  const glass = "bg-[#161b22]/40 backdrop-blur-md rounded-3xl border border-white/5 p-8 shadow-2xl";
  const totals = data?.totals;
  const hasSessions = !!totals && totals.sessions > 0;
  const insight = data?.insight ?? null;
  // A day without sessions yields an ok row with an empty analysis.
  const insightEmpty = !!insight && insight.status === "ok" && !insight.summary &&
    insight.findings.length === 0 && insight.fleet.length === 0;

  // Feature turned off in Terraform (enable_session_insights = false): render nothing.
  if (disabled) return null;

  return (
    <section aria-labelledby="session-insights-title" className="space-y-6">
      <PanelHeader
        id="session-insights-title"
        title={t("sessionInsights.title")}
        subtitle={t("sessionInsights.subtitle")}
        icon={MessagesSquare}
        action={
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="text-[10px] font-black text-primary-400 hover:text-primary-300 uppercase tracking-widest flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} aria-hidden="true" />
            {t("sessionInsights.reload")}
          </button>
        }
      />

      <div aria-live="polite" className="sr-only">
        {loading ? t("sessionInsights.loading") : loadError ? t("sessionInsights.loadError") : ""}
      </div>

      {loadError && !data && (
        <div className={cn(glass, "text-center")} role="alert">
          <p className="text-sm text-rose-300">{t("sessionInsights.loadError")}</p>
        </div>
      )}

      {loading && !data && (
        <div className={cn(glass, "text-center")}>
          <p className="text-sm text-gray-500">{t("sessionInsights.loading")}</p>
        </div>
      )}

      {data && !hasSessions && (
        <div className={cn(glass, "text-center space-y-2")}>
          <p className="text-sm font-bold text-gray-300">{t("sessionInsights.emptyTitle")}</p>
          <p className="text-xs text-gray-500">{t("sessionInsights.emptyBody")}</p>
        </div>
      )}

      {data && totals && hasSessions && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard title={t("sessionInsights.sessions")} value={totals.sessions.toLocaleString()} description={t("sessionInsights.last7Days")} />
            <StatCard title={t("sessionInsights.avgTurns")} value={totals.avgTurnsPerSession.toFixed(1)} description={`${totals.turns.toLocaleString()} ${t("sessionInsights.turnsTotal")}`} />
            <StatCard title={t("sessionInsights.avgCostSession")} value={formatCost(totals.costPerSession)} description={t("sessionInsights.last7Days")} />
            <StatCard title={t("sessionInsights.avgCostTurn")} value={formatCost(totals.costPerTurn)} description={t("sessionInsights.last7Days")} />
          </div>

          <div className={glass}>
            <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4">{t("sessionInsights.topUsers")}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t("sessionInsights.topUsers")}</caption>
                <thead>
                  <tr className="text-left text-[10px] font-black text-gray-500 uppercase tracking-widest border-b border-white/5">
                    <th scope="col" className="py-2 pr-4">{t("sessionInsights.col.user")}</th>
                    <th scope="col" className="py-2 pr-4 text-right">{t("sessionInsights.col.sessions")}</th>
                    <th scope="col" className="py-2 pr-4 text-right">{t("sessionInsights.col.turns")}</th>
                    <th scope="col" className="py-2 pr-4 text-right">{t("sessionInsights.col.cost")}</th>
                    <th scope="col" className="py-2 pr-4 text-right">{t("sessionInsights.col.perTurn")}</th>
                    <th scope="col" className="py-2 pr-4 text-right">{t("sessionInsights.col.perSession")}</th>
                    <th scope="col" className="py-2 text-right">{t("sessionInsights.col.split")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topUsers.map((u) => (
                    <tr key={u.email} className="border-b border-white/5 last:border-0">
                      <th scope="row" className="py-2 pr-4 text-left font-medium text-gray-200">
                        <span className="block truncate max-w-[16rem]">{u.email}</span>
                        <span className="block text-[10px] text-gray-500">{u.department}</span>
                      </th>
                      <td className="py-2 pr-4 text-right text-gray-300 tabular-nums">{u.sessions}</td>
                      <td className="py-2 pr-4 text-right text-gray-300 tabular-nums">{u.turns}</td>
                      <td className="py-2 pr-4 text-right text-white font-bold tabular-nums">{formatCost(u.estimatedCost)}</td>
                      <td className="py-2 pr-4 text-right text-gray-300 tabular-nums">{formatCost(u.costPerTurn)}</td>
                      <td className="py-2 pr-4 text-right text-gray-300 tabular-nums">{formatCost(u.costPerSession)}</td>
                      <td className="py-2 text-right text-xs text-gray-400 tabular-nums whitespace-nowrap">
                        Claude {formatCost(u.tools.claude.estimatedCost)} ({u.tools.claude.sessions})
                        {" · "}
                        Codex {formatCost(u.tools.codex.estimatedCost)} ({u.tools.codex.sessions})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-gray-500">
              {data.coverage === null
                ? t("sessionInsights.coverageNone")
                : t("sessionInsights.coverage").replace("{pct}", String(Math.round(data.coverage * 100)))}
              {" "}
              {t("sessionInsights.coverageSource")}
            </p>
          </div>
        </>
      )}

      {data && (
        <div className={glass}>
          <PanelHeader
            title={t("sessionInsights.aiTitle")}
            subtitle={
              insight
                ? `${t("sessionInsights.generated")} ${formatTime(insight.generatedAt)} · ${insight.model}`
                : t("sessionInsights.aiNone")
            }
            icon={Sparkles}
            action={
              <button
                type="button"
                onClick={regenerate}
                disabled={regenerating}
                aria-busy={regenerating}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all",
                  "bg-[#0d1117] border border-white/5 text-gray-300 hover:text-white hover:border-primary-500/50",
                  regenerating && "opacity-50 cursor-not-allowed"
                )}
              >
                <RefreshCw className={cn("w-3.5 h-3.5", regenerating && "animate-spin text-primary-500")} aria-hidden="true" />
                {regenerating ? t("sessionInsights.regenerating") : t("sessionInsights.regenerate")}
              </button>
            }
          />
          <div aria-live="polite" className="text-xs mb-4">
            {regenerating && <p className="text-gray-400">{t("sessionInsights.regenerating")}</p>}
            {regenError && <p className="text-rose-300" role="alert">{t("sessionInsights.regenError")}: {regenError}</p>}
            {regenDone && !regenError && <p className="text-emerald-400">{t("sessionInsights.regenDone")}</p>}
            {regenTimedOut && <p className="text-amber-300">{t("sessionInsights.regenTimeout")}</p>}
          </div>

          {insight && insight.status === "error" && (
            <p className="text-sm text-amber-300 mb-4">{t("sessionInsights.aiError")}: {insight.error}</p>
          )}
          {insightEmpty && (
            <p className="text-sm text-gray-500 mb-4">{t("sessionInsights.aiEmpty")}</p>
          )}
          {insight && insight.summary && (
            <p className="text-sm text-gray-200 leading-relaxed mb-6">{insight.summary}</p>
          )}
          {insight && insight.findings.length > 0 && (
            <ul className="space-y-3 mb-6">
              {insight.findings.map((f, i) => (
                <li key={`${f.label}-${i}`} className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-black uppercase border", SEVERITY_STYLE[f.severity])}>
                      {t(`sessionInsights.severity.${f.severity}`)}
                    </span>
                    <span className="text-sm font-bold text-white">{f.title}</span>
                    {f.user && <span className="text-xs text-gray-500">{f.user}</span>}
                  </div>
                  {f.detail && <p className="text-xs text-gray-300">{f.detail}</p>}
                  {f.suggestion && (
                    <p className="text-xs text-primary-300 mt-1">
                      <span className="font-bold">{t("sessionInsights.suggestion")}:</span> {f.suggestion}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {insight && insight.fleet.length > 0 && (
            <div>
              <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">{t("sessionInsights.fleet")}</h3>
              <ul className="list-disc pl-5 space-y-1 text-xs text-gray-300">
                {insight.fleet.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-6 text-[10px] text-gray-600">{t("sessionInsights.privacy")}</p>
        </div>
      )}
    </section>
  );
}
