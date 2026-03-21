import type { StatCardData } from "@/lib/types";

export default function StatCard({ title, value, description, trend }: StatCardData) {
  return (
    <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{title}</p>
        {trend && (
          <span
            className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${
              trend.isPositive
                ? "bg-green-900/40 text-green-400"
                : "bg-red-900/40 text-red-400"
            }`}
          >
            {trend.isPositive ? "+" : ""}
            {trend.value}%
          </span>
        )}
      </div>
      <p className="mt-2 text-3xl font-bold text-gray-100">{value}</p>
      {description && (
        <p className="mt-1 text-xs text-gray-500">{description}</p>
      )}
    </div>
  );
}
