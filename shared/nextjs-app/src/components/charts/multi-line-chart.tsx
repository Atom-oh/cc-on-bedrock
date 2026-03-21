"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface LineSeries {
  key: string;
  name: string;
  color: string;
}

interface MultiLineChartProps {
  data: Record<string, unknown>[];
  series: LineSeries[];
  title: string;
  height?: number;
  yFormatter?: (v: number) => string;
}

export default function MultiLineChart({
  data,
  series,
  title,
  height = 280,
  yFormatter,
}: MultiLineChartProps) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
      <h4 className="text-sm font-medium text-gray-300 mb-3">{title}</h4>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              stroke="#4b5563"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              stroke="#4b5563"
              tickFormatter={
                yFormatter ??
                ((v: number) =>
                  v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v))
              }
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1f2937",
                border: "1px solid #374151",
                borderRadius: "0.5rem",
                color: "#f3f4f6",
              }}
              formatter={(value: number) => [value.toLocaleString(), ""]}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: "#9ca3af" }} />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
