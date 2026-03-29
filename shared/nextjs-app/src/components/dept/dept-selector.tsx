"use client";

import { useI18n } from "@/lib/i18n";
import type { DepartmentListItem } from "@/lib/types";

interface DeptSelectorProps {
  departments: DepartmentListItem[];
  selected: string;
  onSelect: (department: string) => void;
}

export default function DeptSelector({ departments, selected, onSelect }: DeptSelectorProps) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
      {/* "All" pill */}
      <button
        onClick={() => onSelect("all")}
        className={`flex-shrink-0 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
          selected === "all"
            ? "bg-blue-600 text-white"
            : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300"
        }`}
      >
        {t("dept.allDepartments") || "All Departments"}
        <span className="ml-1.5 text-xs opacity-70">
          ({departments.reduce((sum, d) => sum + d.memberCount, 0)})
        </span>
      </button>

      {/* Department pills */}
      {departments.map((dept) => (
        <button
          key={dept.department}
          onClick={() => onSelect(dept.department)}
          className={`flex-shrink-0 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            selected === dept.department
              ? "bg-blue-600 text-white"
              : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300"
          }`}
        >
          <span className="capitalize">{dept.department}</span>
          <span className="ml-1.5 text-xs opacity-70">({dept.memberCount})</span>
          {dept.pendingCount > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold bg-yellow-500 text-black rounded-full">
              {dept.pendingCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
