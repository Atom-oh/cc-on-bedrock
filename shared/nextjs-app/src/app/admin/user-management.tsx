"use client";

import { useState, useEffect, useCallback } from "react";
import UsersTable from "@/components/tables/users-table";
import type { CognitoUser, CreateUserInput, ApiResponse } from "@/lib/types";

export default function UserManagement() {
  const [users, setUsers] = useState<CognitoUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [email, setEmail] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [containerOs, setContainerOs] = useState<CreateUserInput["containerOs"]>("ubuntu");
  const [resourceTier, setResourceTier] = useState<CreateUserInput["resourceTier"]>("standard");
  const [securityPolicy, setSecurityPolicy] = useState<CreateUserInput["securityPolicy"]>("restricted");

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/users");
      const json = (await res.json()) as ApiResponse<CognitoUser[]>;
      if (json.success && json.data) {
        setUsers(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch users:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          subdomain,
          containerOs,
          resourceTier,
          securityPolicy,
        } satisfies CreateUserInput),
      });
      const json = (await res.json()) as ApiResponse<CognitoUser>;
      if (!json.success) {
        setError(json.error ?? "Failed to create user");
        return;
      }
      // Reset form and refresh
      setEmail("");
      setSubdomain("");
      setContainerOs("ubuntu");
      setResourceTier("standard");
      setSecurityPolicy("restricted");
      setShowCreateForm(false);
      void fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (username: string) => {
    if (!confirm(`Are you sure you want to delete user "${username}"? This will also remove their LiteLLM API key.`)) {
      return;
    }
    try {
      await fetch(`/api/users?username=${encodeURIComponent(username)}`, {
        method: "DELETE",
      });
      void fetchUsers();
    } catch (err) {
      console.error("Failed to delete user:", err);
    }
  };

  const handleToggle = async (username: string, enable: boolean) => {
    try {
      await fetch(
        `/api/users?username=${encodeURIComponent(username)}&action=${enable ? "enable" : "disable"}`,
        { method: "DELETE" }
      );
      void fetchUsers();
    } catch (err) {
      console.error("Failed to toggle user:", err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {users.length} user{users.length !== 1 ? "s" : ""} total
        </p>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
        >
          {showCreateForm ? "Cancel" : "Create User"}
        </button>
      </div>

      {/* Create user form */}
      {showCreateForm && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-gray-100 mb-4">
            Create New User
          </h3>
          {error && (
            <div className="mb-4 p-3 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-lg">
              {error}
            </div>
          )}
          <form onSubmit={(e) => void handleCreate(e)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 placeholder-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Subdomain
                </label>
                <input
                  type="text"
                  required
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 placeholder-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="user01"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Container OS
                </label>
                <select
                  value={containerOs}
                  onChange={(e) => setContainerOs(e.target.value as CreateUserInput["containerOs"])}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="ubuntu">Ubuntu 24.04</option>
                  <option value="al2023">Amazon Linux 2023</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Resource Tier
                </label>
                <select
                  value={resourceTier}
                  onChange={(e) => setResourceTier(e.target.value as CreateUserInput["resourceTier"])}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="light">Light (1 vCPU / 4 GiB)</option>
                  <option value="standard">Standard (2 vCPU / 8 GiB)</option>
                  <option value="power">Power (4 vCPU / 12 GiB)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Security Policy
                </label>
                <select
                  value={securityPolicy}
                  onChange={(e) => setSecurityPolicy(e.target.value as CreateUserInput["securityPolicy"])}
                  className="w-full px-3 py-2 text-sm bg-[#0d1117] border border-gray-700 text-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="open">Open (Education/Lab)</option>
                  <option value="restricted">Restricted (General)</option>
                  <option value="locked">Locked (High Security)</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? "Creating..." : "Create User"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Users table */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-sm text-gray-500">Loading users...</div>
        </div>
      ) : (
        <UsersTable
          users={users}
          onDelete={handleDelete}
          onToggle={handleToggle}
        />
      )}
    </div>
  );
}
