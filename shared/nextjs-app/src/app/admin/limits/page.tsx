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

export default function AdminLimitsPage() {
  const [rows, setRows] = useState<LimitItem[]>([]);
  const [loading, setLoading] = useState(false);
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
    <div className="p-8 max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Normalized Token Limits</h1>
        <p className="text-sm text-gray-600 mt-1">
          Per-user and per-department <em>normalized token</em> limits for Local
          Governance Mode (ADR-014). When usage reaches the limit, a Deny policy is
          attached to the user&apos;s IAM role until the next period reset.
        </p>
      </header>

      <section className="border rounded p-4 bg-white">
        <h2 className="text-lg font-medium mb-3">Add / Update limit</h2>
        <div className="grid grid-cols-5 gap-2 items-end">
          <label className="flex flex-col text-xs">
            <span className="text-gray-500 mb-1">Entity</span>
            <select
              className="border rounded px-2 py-1"
              value={form.entity}
              onChange={(e) => setForm({ ...form, entity: e.target.value as LimitItem["entity"] })}
            >
              <option value="USER">USER</option>
              <option value="DEPT">DEPT</option>
            </select>
          </label>
          <label className="flex flex-col text-xs col-span-2">
            <span className="text-gray-500 mb-1">
              {form.entity === "USER" ? "Cognito sub" : "Department"}
            </span>
            <input
              className="border rounded px-2 py-1"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder={form.entity === "USER" ? "a1b2c3d4-…" : "platform-team"}
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="text-gray-500 mb-1">Period</span>
            <select
              className="border rounded px-2 py-1"
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
            <span className="text-gray-500 mb-1">Max normalized</span>
            <input
              className="border rounded px-2 py-1"
              type="number"
              min={0}
              value={form.maxNormalized}
              onChange={(e) =>
                setForm({ ...form, maxNormalized: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={save}
            className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm"
            disabled={!form.key}
          >
            Save
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </section>

      <section className="border rounded p-4 bg-white">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium">Current limits</h2>
          <button onClick={load} className="text-xs text-blue-600">
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 border-b">
            <tr>
              <th className="text-left py-1">Entity</th>
              <th className="text-left py-1">Key</th>
              <th className="text-left py-1">Period</th>
              <th className="text-right py-1">Max normalized</th>
              <th className="text-left py-1 pl-3">Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-gray-500 py-4">
                  No limits configured.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={`${r.entity}-${r.key}-${r.period}-${i}`} className="border-b last:border-0">
                <td className="py-1">{r.entity}</td>
                <td className="py-1 font-mono text-xs">{r.key}</td>
                <td className="py-1">{r.period}</td>
                <td className="py-1 text-right tabular-nums">
                  {r.maxNormalized.toLocaleString()}
                </td>
                <td className="py-1 pl-3 text-xs text-gray-500">{r.updatedAt ?? "—"}</td>
                <td className="py-1 text-right">
                  <button onClick={() => remove(r)} className="text-xs text-red-600">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
