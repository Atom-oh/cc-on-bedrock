"use client";

import { useState, useMemo } from "react";
import type { CognitoUser } from "@/lib/types";

interface UsersTableProps {
  users: CognitoUser[];
  onResetEnvironment?: (username: string) => void;
  onPermanentDelete?: (username: string) => void;
  onToggle?: (username: string, enabled: boolean) => void;
  onUpdate?: (username: string, field: string, value: string) => Promise<void>;
}

const tierBadge: Record<string, string> = {
  light: "bg-gray-800 text-gray-400",
  standard: "bg-blue-900/40 text-blue-400",
  power: "bg-purple-900/40 text-purple-400",
};

const policyBadge: Record<string, string> = {
  open: "bg-green-900/40 text-green-400",
  restricted: "bg-yellow-900/40 text-yellow-400",
  locked: "bg-red-900/40 text-red-400",
};

const storageBadge: Record<string, string> = {
  ebs: "bg-indigo-900/40 text-indigo-400",
  efs: "bg-teal-900/40 text-teal-400",
};

const statusBadge: Record<string, string> = {
  CONFIRMED: "bg-green-900/40 text-green-400",
  FORCE_CHANGE_PASSWORD: "bg-yellow-900/40 text-yellow-400",
  DISABLED: "bg-gray-800 text-gray-500",
};

type SortKey = "email" | "subdomain" | "containerOs" | "resourceTier" | "securityPolicy" | "storageType" | "status";
type SortDir = "asc" | "desc";

const tierOrder: Record<string, number> = { light: 0, standard: 1, power: 2 };
const policyOrder: Record<string, number> = { open: 0, restricted: 1, locked: 2 };

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <svg className={`inline-block w-3 h-3 ml-1 ${active ? "text-blue-400" : "text-gray-700"}`} viewBox="0 0 12 12" fill="currentColor">
      <path d={dir === "asc" || !active ? "M6 2l3 4H3z" : ""} opacity={active && dir === "desc" ? 0.3 : 1} />
      <path d={dir === "desc" || !active ? "M6 10l3-4H3z" : ""} opacity={active && dir === "asc" ? 0.3 : 1} />
    </svg>
  );
}

export default function UsersTable({
  users,
  onResetEnvironment,
  onPermanentDelete,
  onToggle,
  onUpdate,
}: UsersTableProps) {
  const [editingCell, setEditingCell] = useState<{ username: string; field: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const handleInlineChange = async (username: string, field: string, value: string) => {
    if (!onUpdate) return;
    setSaving(true);
    try {
      await onUpdate(username, field, value);
    } finally {
      setSaving(false);
      setEditingCell(null);
    }
  };
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("email");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterOs, setFilterOs] = useState<string>("all");
  const [filterTier, setFilterTier] = useState<string>("all");
  const [filterPolicy, setFilterPolicy] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterStorage, setFilterStorage] = useState<string>("all");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const activeFilters = [filterOs, filterTier, filterPolicy, filterStatus, filterStorage].filter((f) => f !== "all").length + (search ? 1 : 0);

  const sorted = useMemo(() => {
    const filtered = users.filter((u) => {
      if (search) {
        const q = search.toLowerCase();
        if (!(u.email.toLowerCase().includes(q) || u.subdomain.toLowerCase().includes(q))) return false;
      }
      if (filterOs !== "all" && u.containerOs !== filterOs) return false;
      if (filterTier !== "all" && u.resourceTier !== filterTier) return false;
      if (filterPolicy !== "all" && u.securityPolicy !== filterPolicy) return false;
      if (filterStorage !== "all" && (u.storageType ?? "efs") !== filterStorage) return false;
      if (filterStatus === "enabled" && !u.enabled) return false;
      if (filterStatus === "disabled" && u.enabled) return false;
      if (filterStatus === "pending" && u.status !== "FORCE_CHANGE_PASSWORD") return false;
      return true;
    });
    const mul = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "email": return mul * a.email.localeCompare(b.email);
        case "subdomain": return mul * a.subdomain.localeCompare(b.subdomain);
        case "containerOs": return mul * a.containerOs.localeCompare(b.containerOs);
        case "resourceTier": return mul * ((tierOrder[a.resourceTier] ?? 0) - (tierOrder[b.resourceTier] ?? 0));
        case "securityPolicy": return mul * ((policyOrder[a.securityPolicy] ?? 0) - (policyOrder[b.securityPolicy] ?? 0));
        case "storageType": return mul * (a.storageType ?? "efs").localeCompare(b.storageType ?? "efs");
        case "status": {
          const sa = a.enabled ? (a.status === "CONFIRMED" ? 2 : 1) : 0;
          const sb = b.enabled ? (b.status === "CONFIRMED" ? 2 : 1) : 0;
          return mul * (sa - sb);
        }
        default: return 0;
      }
    });
  }, [users, search, filterOs, filterTier, filterPolicy, filterStorage, filterStatus, sortKey, sortDir]);

  const thClass = "px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-300 transition-colors";
  const selectClass = "px-2 py-1.5 text-xs bg-[#0d1117] border border-gray-700 text-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="bg-[#161b22] rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by email or subdomain..."
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
        <select value={filterPolicy} onChange={(e) => setFilterPolicy(e.target.value)} className={selectClass}>
          <option value="all">All Security</option>
          <option value="open">Open</option>
          <option value="restricted">Restricted</option>
          <option value="locked">Locked</option>
        </select>
        <select value={filterStorage} onChange={(e) => setFilterStorage(e.target.value)} className={selectClass}>
          <option value="all">All Storage</option>
          <option value="ebs">EBS</option>
          <option value="efs">EFS</option>
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={selectClass}>
          <option value="all">All Status</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="pending">Pending</option>
        </select>
        {activeFilters > 0 && (
          <button
            onClick={() => { setSearch(""); setFilterOs("all"); setFilterTier("all"); setFilterPolicy("all"); setFilterStorage("all"); setFilterStatus("all"); }}
            className="px-2 py-1 text-[10px] text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
          >
            Clear ({activeFilters})
          </button>
        )}
        <span className="ml-auto text-[10px] text-gray-600">{sorted.length} / {users.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800 bg-[#0d1117]">
              <th className={thClass} onClick={() => handleSort("email")}>User<SortIcon active={sortKey === "email"} dir={sortDir} /></th>
              <th className={thClass} onClick={() => handleSort("subdomain")}>Subdomain<SortIcon active={sortKey === "subdomain"} dir={sortDir} /></th>
              <th className={thClass} onClick={() => handleSort("containerOs")}>OS<SortIcon active={sortKey === "containerOs"} dir={sortDir} /></th>
              <th className={thClass} onClick={() => handleSort("resourceTier")}>Tier<SortIcon active={sortKey === "resourceTier"} dir={sortDir} /></th>
              <th className={thClass} onClick={() => handleSort("securityPolicy")}>Security<SortIcon active={sortKey === "securityPolicy"} dir={sortDir} /></th>
              <th className={thClass} onClick={() => handleSort("storageType")}>Storage<SortIcon active={sortKey === "storageType"} dir={sortDir} /></th>
              <th className={thClass} onClick={() => handleSort("status")}>Status<SortIcon active={sortKey === "status"} dir={sortDir} /></th>
              <th className="px-5 py-3 text-right text-[10px] font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {sorted.map((user) => (
              <tr key={user.username} className="hover:bg-gray-800/30 transition-colors">
                <td className="px-5 py-3.5 whitespace-nowrap">
                  <p className="text-sm font-medium text-gray-200">{user.email}</p>
                  <p className="text-[10px] text-gray-600">{user.username}</p>
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap text-sm text-gray-400">{user.subdomain}</td>
                <td className="px-5 py-3.5 whitespace-nowrap">
                  {editingCell?.username === user.username && editingCell?.field === "containerOs" ? (
                    <select autoFocus className="px-2 py-1 text-xs bg-[#0d1117] border border-blue-500 text-gray-200 rounded-lg focus:outline-none"
                      defaultValue={user.containerOs} disabled={saving}
                      onChange={(e) => handleInlineChange(user.username, "containerOs", e.target.value)}
                      onBlur={() => setEditingCell(null)}>
                      <option value="ubuntu">Ubuntu</option>
                      <option value="al2023">AL2023</option>
                    </select>
                  ) : (
                    <button onClick={() => onUpdate && setEditingCell({ username: user.username, field: "containerOs" })}
                      className={`text-sm text-gray-400 ${onUpdate ? "hover:text-blue-400 cursor-pointer" : ""}`}>
                      {user.containerOs === "al2023" ? "Amazon Linux" : "Ubuntu"}
                    </button>
                  )}
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap">
                  {editingCell?.username === user.username && editingCell?.field === "resourceTier" ? (
                    <select autoFocus className="px-2 py-1 text-xs bg-[#0d1117] border border-blue-500 text-gray-200 rounded-lg focus:outline-none"
                      defaultValue={user.resourceTier} disabled={saving}
                      onChange={(e) => handleInlineChange(user.username, "resourceTier", e.target.value)}
                      onBlur={() => setEditingCell(null)}>
                      <option value="light">Light</option>
                      <option value="standard">Standard</option>
                      <option value="power">Power</option>
                    </select>
                  ) : (
                    <button onClick={() => onUpdate && setEditingCell({ username: user.username, field: "resourceTier" })}
                      className={`inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full ${tierBadge[user.resourceTier] ?? tierBadge.standard} ${onUpdate ? "hover:ring-1 hover:ring-blue-500 cursor-pointer" : ""}`}>
                      {user.resourceTier}
                    </button>
                  )}
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap">
                  {editingCell?.username === user.username && editingCell?.field === "securityPolicy" ? (
                    <select autoFocus className="px-2 py-1 text-xs bg-[#0d1117] border border-blue-500 text-gray-200 rounded-lg focus:outline-none"
                      defaultValue={user.securityPolicy} disabled={saving}
                      onChange={(e) => handleInlineChange(user.username, "securityPolicy", e.target.value)}
                      onBlur={() => setEditingCell(null)}>
                      <option value="open">Open</option>
                      <option value="restricted">Restricted</option>
                      <option value="locked">Locked</option>
                    </select>
                  ) : (
                    <button onClick={() => onUpdate && setEditingCell({ username: user.username, field: "securityPolicy" })}
                      className={`inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full ${policyBadge[user.securityPolicy] ?? policyBadge.restricted} ${onUpdate ? "hover:ring-1 hover:ring-blue-500 cursor-pointer" : ""}`}>
                      {user.securityPolicy}
                    </button>
                  )}
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full uppercase ${storageBadge[user.storageType ?? "ebs"] ?? storageBadge.ebs}`}>
                    {(user.storageType ?? "ebs").toUpperCase()}
                  </span>
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full ${statusBadge[user.status] ?? "bg-gray-800 text-gray-500"}`}>
                    {user.status === "FORCE_CHANGE_PASSWORD" ? "Pending" : user.enabled ? user.status : "Disabled"}
                  </span>
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap text-right">
                  <div className="flex items-center justify-end gap-2">
                    {onToggle && (
                      <button
                        onClick={() => onToggle(user.username, !user.enabled)}
                        className={`px-2 py-1 text-xs font-medium rounded-lg transition-colors ${
                          user.enabled
                            ? "text-yellow-400 hover:bg-yellow-900/30"
                            : "text-green-400 hover:bg-green-900/30"
                        }`}
                      >
                        {user.enabled ? "Disable" : "Enable"}
                      </button>
                    )}
                    {onResetEnvironment && user.subdomain && (
                      <button
                        onClick={() => onResetEnvironment(user.username)}
                        className="px-2 py-1 text-xs font-medium text-orange-400 hover:bg-orange-900/30 rounded-lg transition-colors"
                      >
                        Reset Env
                      </button>
                    )}
                    {onPermanentDelete && (
                      <button
                        onClick={() => onPermanentDelete(user.username)}
                        className="px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30 rounded-lg transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="px-6 py-12 text-center text-sm text-gray-600">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
