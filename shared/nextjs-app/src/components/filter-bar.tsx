"use client";

import { useState } from "react";

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

interface FilterBarProps {
  filters: {
    key: string;
    label: string;
    options: FilterOption[];
    value: string;
    onChange: (value: string) => void;
  }[];
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
}

export default function FilterBar({ filters, searchPlaceholder, searchValue, onSearchChange }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 p-3 bg-[#111827] rounded-xl border border-gray-800/50">
      {/* Search */}
      {onSearchChange && (
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchValue ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder ?? "Search..."}
            className="pl-8 pr-3 py-1.5 w-48 text-xs bg-[#0a0f1a] border border-gray-800 text-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-cyan-500/50 placeholder-gray-600"
          />
        </div>
      )}

      {/* Filter dropdowns */}
      {filters.map((f) => (
        <div key={f.key} className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500">{f.label}:</span>
          <select
            value={f.value}
            onChange={(e) => f.onChange(e.target.value)}
            className="px-2 py-1.5 text-xs bg-[#0a0f1a] border border-gray-800 text-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-cyan-500/50 appearance-none cursor-pointer pr-6"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 6px center" }}
          >
            {f.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}{opt.count !== undefined ? ` (${opt.count})` : ""}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
