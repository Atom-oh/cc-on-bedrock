"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface AreaSeries {
  key: string;
  name: string;
  color: string;
}

interface AreaTrendChartProps {
  data: Record<string, unknown>[];
  series: AreaSeries[];
  title: string;
  height?: number;
  yFormatter?: (v: number) => string;
}

function defaultYFormatter(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

export default function AreaTrendChart({
  data,
  series,
  title,
  height = 280,
  yFormatter = defaultYFormatter,
}: AreaTrendChartProps) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
      <h4 className="text-sm font-medium text-gray-300 mb-3">{title}</h4>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
          >
            <defs>
              {series.map((s) => (
                <linearGradient
                  key={s.key}
                  id={`gradient-${s.key}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor={s.color} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={s.color} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              stroke="#4b5563"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              stroke="#4b5563"
              tickFormatter={yFormatter}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1f2937",
                border: "1px solid #374151",
                borderRadius: "0.5rem",
                color: "#f3f4f6",
              }}
              formatter={(value: number, name: string) => [
                value.toLocaleString(),
                name,
              ]}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, color: "#9ca3af" }}
            />
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#gradient-${s.key})`}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
