"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

interface LeaderboardEntry {
  name: string;
  value: number;
}

interface LeaderboardChartProps {
  data: LeaderboardEntry[];
  title: string;
  color?: string;
  valueFormatter?: (v: number) => string;
}

function formatValue(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

export default function LeaderboardChart({
  data,
  title,
  color = "#3b82f6",
  valueFormatter = formatValue,
}: LeaderboardChartProps) {
  return (
    <div className="flex-1 min-w-0">
      <h4 className="text-xs font-medium text-gray-400 mb-3">{title}</h4>
      <div className="space-y-1">
        {data.slice(0, 10).map((entry, i) => {
          const maxVal = data[0]?.value || 1;
          const pct = (entry.value / maxVal) * 100;
          return (
            <div key={entry.name} className="flex items-center gap-2 text-xs">
              <span className="text-gray-500 w-8 text-right shrink-0">
                {valueFormatter(entry.value)}
              </span>
              <div className="flex-1 min-w-0 relative h-5">
                <div
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{
                    width: `${Math.max(pct, 2)}%`,
                    backgroundColor: color,
                    opacity: 1 - i * 0.06,
                  }}
                />
                <span className="relative z-10 px-2 leading-5 text-white truncate block">
                  {entry.name}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
