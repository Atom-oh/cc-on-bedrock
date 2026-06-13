"use client";

import { useState } from "react";
import MultiLineChart from "./multi-line-chart";
import { OTHERS_KEY, type UserDailyTrend } from "@/lib/usage-client";

const PALETTE = [
  "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa",
  "#22d3ee", "#fb923c", "#4ade80", "#e879f9", "#facc15",
  "#38bdf8", "#f472b6", "#2dd4bf", "#c084fc", "#fca5a5",
];
const OTHERS_COLOR = "#6b7280";

interface Props {
  trend: UserDailyTrend;
  title?: string;
}

export default function UserDailyTrendChart({ trend, title = "User Daily Usage" }: Props) {
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");

  const series = trend.series.map((s, i) => ({
    key: s.key,
    name: s.name,
    color: s.key === OTHERS_KEY ? OTHERS_COLOR : PALETTE[i % PALETTE.length],
  }));
  const data = metric === "cost" ? trend.cost : trend.tokens;
  const yFormatter =
    metric === "cost"
      ? (v: number) => `$${v.toFixed(2)}`
      : (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v));

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="inline-flex rounded-md border border-gray-700 overflow-hidden text-xs">
          {(["cost", "tokens"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-3 py-1 ${metric === m ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300"}`}
            >
              {m === "cost" ? "Cost ($)" : "Tokens"}
            </button>
          ))}
        </div>
        {trend.othersCount > 0 && (
          <span className="text-xs text-gray-500">
            Top {trend.series.length - 1} shown · others ({trend.othersCount}) folded
          </span>
        )}
      </div>
      <MultiLineChart data={data} series={series} title={title} yFormatter={yFormatter} />
    </div>
  );
}
