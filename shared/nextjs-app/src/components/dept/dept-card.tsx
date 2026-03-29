"use client";

import type { DepartmentListItem } from "@/lib/types";

interface DeptCardProps {
  dept: DepartmentListItem;
  onClick: (department: string) => void;
}

export default function DeptCard({ dept, onClick }: DeptCardProps) {
  const utilColor =
    dept.budgetUtilization >= 90
      ? "bg-red-500"
      : dept.budgetUtilization >= 70
      ? "bg-yellow-500"
      : "bg-green-500";

  const formatCost = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(2)}`;

  const formatTokens = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
      ? `${(n / 1_000).toFixed(0)}K`
      : String(n);

  return (
    <button
      onClick={() => onClick(dept.department)}
      className="w-full text-left bg-[#161b22] rounded-xl border border-gray-800 p-5 hover:border-gray-600 hover:bg-[#1c2129] transition-all group"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-gray-100 capitalize group-hover:text-blue-400 transition-colors">
          {dept.department}
        </h3>
        {dept.pendingCount > 0 && (
          <span className="px-2 py-0.5 text-xs font-medium bg-yellow-900/40 text-yellow-400 rounded-full">
            {dept.pendingCount} pending
          </span>
        )}
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="text-xs text-gray-500">Members</p>
          <p className="text-lg font-bold text-gray-200">{dept.memberCount}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Cost</p>
          <p className="text-lg font-bold text-gray-200">{formatCost(dept.totalCost)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Tokens</p>
          <p className="text-lg font-bold text-gray-200">{formatTokens(dept.totalTokens)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Requests</p>
          <p className="text-lg font-bold text-gray-200">{dept.requests.toLocaleString()}</p>
        </div>
      </div>

      {/* Budget utilization bar */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-500">Budget</span>
          <span className="text-xs text-gray-400">
            {dept.budgetUtilization}% of {formatCost(dept.monthlyBudget)}
          </span>
        </div>
        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${utilColor}`}
            style={{ width: `${Math.min(dept.budgetUtilization, 100)}%` }}
          />
        </div>
      </div>
    </button>
  );
}
