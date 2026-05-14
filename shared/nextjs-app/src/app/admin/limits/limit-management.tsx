"use client";

import { useEffect, useState } from "react";

type LimitItem = {
  entity: "USER" | "DEPT";
  key: string;
  period: "daily" | "weekly" | "monthly";
  maxNormalized: number;
  updatedAt?: string;
};

const PERIODS: LimitItem["period"][] = ["daily", "weekly", "monthly"];

const inputBase =
  "bg-[#0d1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 " +
  "placeholder:text-gray-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40 " +
  "disabled:opacity-50";

export default function LimitManagement() {
  const [rows, setRows] = useState<LimitItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<LimitItem>({
    entity: "USER",
    key: "",
    period: "daily",
    maxNormalized: 0,
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/limits", { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
      const j = await r.json();
      setRows(j.limits ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const r = await fetch("/api/admin/limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
      setForm({ ...form, key: "", maxNormalized: 0 });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (it: LimitItem) => {
    if (!confirm(`Delete ${it.entity}#${it.key} ${it.period} limit?`)) return;
    setError(null);
    try {
      const q = new URLSearchParams({ entity: it.entity, key: it.key, period: it.period });
      const r = await fetch(`/api/admin/limits?${q.toString()}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  };

  return (
    <div className="space-y-6">
      {/* Add / Update form */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-bold text-gray-100 mb-4">Add / Update limit</h2>

        <div className="grid grid-cols-1 sm:grid-cols-5 gap-4 items-end">
          <label className="flex flex-col text-xs">
            <span className="text-gray-500 mb-1.5 font-medium">Entity</span>
            <select
              className={inputBase}
              value={form.entity}
              onChange={(e) => setForm({ ...form, entity: e.target.value as LimitItem["entity"] })}
            >
              <option value="USER">USER</option>
              <option value="DEPT">DEPT</option>
            </select>
          </label>

          <label className="flex flex-col text-xs sm:col-span-2">
            <span className="text-gray-500 mb-1.5 font-medium">
              {form.entity === "USER" ? "Cognito sub" : "Department"}
            </span>
            <input
              className={inputBase}
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder={form.entity === "USER" ? "04d8edac-e041-7010-…" : "platform-team"}
            />
          </label>

          <label className="flex flex-col text-xs">
            <span className="text-gray-500 mb-1.5 font-medium">Period</span>
            <select
              className={inputBase}
              value={form.period}
              onChange={(e) => setForm({ ...form, period: e.target.value as LimitItem["period"] })}
            >
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs">
            <span className="text-gray-500 mb-1.5 font-medium">Max normalized</span>
            <input
              className={inputBase}
              type="number"
              min={0}
              value={form.maxNormalized}
              onChange={(e) => setForm({ ...form, maxNormalized: Number(e.target.value) })}
              placeholder="1000000"
            />
          </label>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={save}
            disabled={!form.key || saving}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <p className="text-xs text-gray-500">
            Aliases: daily / weekly / monthly • USER key = Cognito <code>sub</code>, DEPT key = <code>department</code> attribute
          </p>
        </div>

        {error && (
          <p className="mt-3 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {/* Current limits */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800">
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <h2 className="text-lg font-bold text-gray-100">Current limits</h2>
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700">
                <th className="py-3 px-6 font-semibold">Entity</th>
                <th className="py-3 px-6 font-semibold">Key</th>
                <th className="py-3 px-6 font-semibold">Period</th>
                <th className="py-3 px-6 font-semibold text-right">Max normalized</th>
                <th className="py-3 px-6 font-semibold">Updated</th>
                <th className="py-3 px-6" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="text-center text-gray-500 py-10 text-sm">
                    No limits configured. Add one above to enforce token quotas.
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <tr
                  key={`${r.entity}-${r.key}-${r.period}-${i}`}
                  className="border-b border-gray-800 last:border-0 hover:bg-white/[0.02]"
                >
                  <td className="py-3 px-6">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                        r.entity === "USER"
                          ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                          : "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                      }`}
                    >
                      {r.entity}
                    </span>
                  </td>
                  <td className="py-3 px-6 font-mono text-xs text-gray-300">{r.key}</td>
                  <td className="py-3 px-6 text-gray-300">{r.period}</td>
                  <td className="py-3 px-6 text-right tabular-nums text-gray-100 font-semibold">
                    {r.maxNormalized.toLocaleString()}
                  </td>
                  <td className="py-3 px-6 text-xs text-gray-500">{r.updatedAt ?? "—"}</td>
                  <td className="py-3 px-6 text-right">
                    <button
                      onClick={() => remove(r)}
                      className="text-xs text-rose-400 hover:text-rose-300 font-medium"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
