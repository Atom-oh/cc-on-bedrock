"use client";

import { useState, useMemo } from "react";
import type { ContainerInfo } from "@/lib/types";

interface ContainersTableProps {
  containers: ContainerInfo[];
  onStop?: (taskArn: string) => void;
  domainName?: string;
  devSubdomain?: string;
}

const statusColors: Record<string, string> = {
  RUNNING: "bg-green-900/40 text-green-400",
  PENDING: "bg-yellow-900/40 text-yellow-400",
  PROVISIONING: "bg-yellow-900/40 text-yellow-400",
  STOPPED: "bg-gray-800 text-gray-500",
  DEPROVISIONING: "bg-orange-900/40 text-orange-400",
  STOPPING: "bg-orange-900/40 text-orange-400",
};

type SortKey = "user" | "status" | "config" | "started";
type SortDir = "asc" | "desc";

const statusOrder: Record<string, number> = { RUNNING: 3, PENDING: 2, PROVISIONING: 1, STOPPING: 0, DEPROVISIONING: 0, STOPPED: -1 };
const tierOrder: Record<string, number> = { light: 0, standard: 1, power: 2 };

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <svg className={`inline-block w-3 h-3 ml-1 ${active ? "text-blue-400" : "text-gray-700"}`} viewBox="0 0 12 12" fill="currentColor">
      <path d={dir === "asc" || !active ? "M6 2l3 4H3z" : ""} opacity={active && dir === "desc" ? 0.3 : 1} />
      <path d={dir === "desc" || !active ? "M6 10l3-4H3z" : ""} opacity={active && dir === "asc" ? 0.3 : 1} />
    </svg>
  );
}

export default function ContainersTable({
  containers,
  onStop,
  domainName = "atomai.click",
  devSubdomain = "dev",
}: ContainersTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("user");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [search, setSearch] = useState("");
  const [filterOs, setFilterOs] = useState<string>("all");
  const [filterTier, setFilterTier] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const activeFilters = [filterOs, filterTier, filterStatus].filter((f) => f !== "all").length + (search ? 1 : 0);

  const sorted = useMemo(() => {
    const filtered = containers.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        if (!(c.username?.toLowerCase().includes(q) || c.subdomain?.toLowerCase().includes(q))) return false;
      }
      if (filterOs !== "all" && c.containerOs !== filterOs) return false;
      if (filterTier !== "all" && c.resourceTier !== filterTier) return false;
      if (filterStatus !== "all" && c.status !== filterStatus) return false;
      return true;
    });
    const mul = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "user": return mul * (a.username || a.subdomain).localeCompare(b.username || b.subdomain);
        case "status": return mul * ((statusOrder[a.status] ?? -1) - (statusOrder[b.status] ?? -1));
        case "config": {
          const osComp = a.containerOs.localeCompare(b.containerOs);
          if (osComp !== 0) return mul * osComp;
          return mul * ((tierOrder[a.resourceTier] ?? 0) - (tierOrder[b.resourceTier] ?? 0));
        }
        case "started": return mul * ((a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
        default: return 0;
      }
    });
  }, [containers, search, filterOs, filterTier, filterStatus, sortKey, sortDir]);

  const thClass = "px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-300 transition-colors";
  const selectClass = "px-2 py-1.5 text-xs bg-[#0d1117] border border-gray-700 text-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="bg-[#161b22] rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by user or subdomain..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-[220px] px-3 py-1.5 text-xs bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-600"
        />
        <select value={filterOs} onChange={(e) => setFilterOs(e.target.value)} className={selectClass}>
          <option value="all">All OS</option>
          <option value="ubuntu">Ubuntu</option>
          <option value="al2023">AL2023</option>
        </select>
        <select value={filterTier} onChange={(e) => setFilterTier(e.target.value)} className={selectClass}>
          <option value="all">All Tiers</option>
          <option value="light">Light</option>
          <option value="standard">Standard</option>
          <option value="power">Power</option>
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={selectClass}>
          <option value="all">All Status</option>
          <option value="RUNNING">Running</option>
          <option value="PENDING">Pending</option>
          <option value="STOPPED">Stopped</option>
        </select>
        {activeFilters > 0 && (
          <button
            onClick={() => { setSearch(""); setFilterOs("all"); setFilterTier("all"); setFilterStatus("all"); }}
            className="px-2 py-1 text-[10px] text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
          >
            Clear ({activeFilters})
          </button>
        )}
        <span className="ml-auto text-[10px] text-gray-600">{sorted.length} / {containers.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800 bg-[#0d1117]">
              <th className={thClass} onClick={() => handleSort("user")}>
                User / Subdomain<SortIcon active={sortKey === "user"} dir={sortDir} />
              </th>
              <th className={thClass} onClick={() => handleSort("status")}>
                Status<SortIcon active={sortKey === "status"} dir={sortDir} />
              </th>
              <th className={thClass} onClick={() => handleSort("config")}>
                Config<SortIcon active={sortKey === "config"} dir={sortDir} />
              </th>
              <th className={thClass} onClick={() => handleSort("started")}>
                Started<SortIcon active={sortKey === "started"} dir={sortDir} />
              </th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                URL
              </th>
              <th className="px-5 py-3 text-right text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {sorted.map((container) => {
              const url = `https://${container.subdomain}.${devSubdomain}.${domainName}`;
              return (
                <tr key={container.taskArn} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <p className="text-sm font-medium text-gray-200">
                      {container.username || "Unknown"}
                    </p>
                    <p className="text-[10px] text-gray-500">
                      {container.subdomain || container.taskId}
                    </p>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded-full ${
                      statusColors[container.status] ?? "bg-gray-800 text-gray-500"
                    }`}>
                      {container.status === "RUNNING" && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      )}
                      {container.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex gap-1">
                        <span className="px-1.5 py-0.5 text-[10px] bg-gray-800 text-gray-400 rounded">
                          {container.containerOs === "al2023" ? "AL2023" : "Ubuntu"}
                        </span>
                        <span className={`px-1.5 py-0.5 text-[10px] rounded ${
                          container.resourceTier === "power" ? "bg-purple-900/40 text-purple-400" :
                          container.resourceTier === "light" ? "bg-gray-800 text-gray-400" :
                          "bg-blue-900/40 text-blue-400"
                        }`}>
                          {container.resourceTier}
                        </span>
                        {container.storageType && (
                          <span className={`px-1.5 py-0.5 text-[10px] rounded ${
                            container.storageType === "ebs" ? "bg-blue-900/40 text-blue-400" : "bg-green-900/40 text-green-400"
                          }`}>
                            {container.storageType.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span className="text-[9px] text-gray-600">
                        {Math.round(parseInt(container.cpu || "0") / 1024)} vCPU / {Math.round(parseInt(container.memory || "0") / 1024)} GiB
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-xs text-gray-500">
                    {container.startedAt
                      ? new Date(container.startedAt).toLocaleString()
                      : "-"}
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    {container.status === "RUNNING" && container.subdomain ? (
                      container.healthStatus === "HEALTHY" ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                        >
                          {url}
                        </a>
                      ) : (
                        <span className="text-xs text-yellow-500 animate-pulse">Starting...</span>
                      )
                    ) : (
                      <span className="text-xs text-gray-600">-</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-right">
                    {onStop &&
                      (container.status === "RUNNING" ||
                        container.status === "PENDING") && (
                        <button
                          onClick={() => onStop(container.taskArn)}
                          className="px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30 rounded-lg transition-colors"
                        >
                          Stop
                        </button>
                      )}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-6 py-12 text-center text-sm text-gray-600"
                >
                  No containers running.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
