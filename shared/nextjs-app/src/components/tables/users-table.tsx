"use client";

import { useState } from "react";
import type { CognitoUser } from "@/lib/types";

interface UsersTableProps {
  users: CognitoUser[];
  onDelete?: (username: string) => void;
  onToggle?: (username: string, enabled: boolean) => void;
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

const statusBadge: Record<string, string> = {
  CONFIRMED: "bg-green-900/40 text-green-400",
  FORCE_CHANGE_PASSWORD: "bg-yellow-900/40 text-yellow-400",
  DISABLED: "bg-gray-800 text-gray-500",
};

export default function UsersTable({
  users,
  onDelete,
  onToggle,
}: UsersTableProps) {
  const [search, setSearch] = useState("");

  const filtered = users.filter(
    (u) =>
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.subdomain.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="bg-[#161b22] rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800">
        <input
          type="text"
          placeholder="Search users by email or subdomain..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-600"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800 bg-[#0d1117]">
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">User</th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">Subdomain</th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">OS</th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">Tier</th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">Security</th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-5 py-3 text-right text-[10px] font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {filtered.map((user) => (
              <tr key={user.username} className="hover:bg-gray-800/30 transition-colors">
                <td className="px-5 py-3.5 whitespace-nowrap">
                  <p className="text-sm font-medium text-gray-200">{user.email}</p>
                  <p className="text-[10px] text-gray-600">{user.username}</p>
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap text-sm text-gray-400">{user.subdomain}</td>
                <td className="px-5 py-3.5 whitespace-nowrap text-sm text-gray-400">
                  {user.containerOs === "al2023" ? "Amazon Linux" : "Ubuntu"}
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full ${tierBadge[user.resourceTier] ?? tierBadge.standard}`}>
                    {user.resourceTier}
                  </span>
                </td>
                <td className="px-5 py-3.5 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full ${policyBadge[user.securityPolicy] ?? policyBadge.restricted}`}>
                    {user.securityPolicy}
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
                    {onDelete && (
                      <button
                        onClick={() => onDelete(user.username)}
                        className="px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30 rounded-lg transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-sm text-gray-600">
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
