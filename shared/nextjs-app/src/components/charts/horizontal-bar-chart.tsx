"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface HorizontalBarEntry {
  name: string;
  value: number;
}

interface HorizontalBarChartProps {
  data: HorizontalBarEntry[];
  title: string;
  color?: string;
  valueFormatter?: (v: number) => string;
  height?: number;
}

export default function HorizontalBarChart({
  data,
  title,
  color = "#3b82f6",
  valueFormatter,
  height,
}: HorizontalBarChartProps) {
  const chartHeight = height ?? Math.max(data.length * 32, 120);

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
      <h4 className="text-sm font-medium text-gray-300 mb-3">{title}</h4>
      <div style={{ height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 20, left: 10, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#374151"
              horizontal={false}
            />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              stroke="#4b5563"
              tickFormatter={
                valueFormatter ??
                ((v: number) =>
                  v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v))
              }
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: "#d1d5db" }}
              stroke="#4b5563"
              width={120}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1f2937",
                border: "1px solid #374151",
                borderRadius: "0.5rem",
                color: "#f3f4f6",
              }}
              formatter={(value: number) => [
                valueFormatter ? valueFormatter(value) : value.toLocaleString(),
                "",
              ]}
            />
            <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
