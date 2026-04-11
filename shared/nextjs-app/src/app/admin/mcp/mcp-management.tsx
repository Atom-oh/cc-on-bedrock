"use client";

import { useState, useEffect, useCallback } from "react";

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: "common" | "department";
  toolSchema: unknown[];
  version: string;
  enabled: boolean;
}

interface Assignment {
  catalogId: string;
  enabled: boolean;
  targetId: string;
  status: string;
  addedAt: string;
  addedBy: string;
}

interface GatewayInfo {
  deptId: string;
  gatewayId: string;
  gatewayUrl: string;
  gatewayName: string;
  status: string;
  targetCount: number;
  lastSyncAt: string;
  errorMessage: string;
}

type TabType = "catalog" | "assignments" | "gateways";

const CATEGORY_COLORS: Record<string, string> = {
  monitoring: "bg-blue-500/20 text-blue-400",
  development: "bg-green-500/20 text-green-400",
  data: "bg-purple-500/20 text-purple-400",
  communication: "bg-yellow-500/20 text-yellow-400",
};

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-500/20 text-green-400",
  CREATING: "bg-yellow-500/20 text-yellow-400",
  SYNCING: "bg-blue-500/20 text-blue-400",
  PENDING: "bg-gray-500/20 text-gray-400",
  FAILED: "bg-red-500/20 text-red-400",
};

export default function McpManagement() {
  const [activeTab, setActiveTab] = useState<TabType>("catalog");
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [gateways, setGateways] = useState<GatewayInfo[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedDept, setSelectedDept] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/mcp/catalog");
      const json = await res.json();
      if (json.success) setCatalog(json.data ?? []);
    } catch (err) {
      console.error("Failed to fetch catalog:", err);
    }
  }, []);

  const fetchGateways = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/mcp/gateways");
      const json = await res.json();
      if (json.success) setGateways(json.data ?? []);
    } catch (err) {
      console.error("Failed to fetch gateways:", err);
    }
  }, []);

  const fetchAssignments = useCallback(async (deptId: string) => {
    if (!deptId) return;
    try {
      const res = await fetch(`/api/admin/mcp/assignments?dept_id=${deptId}`);
      const json = await res.json();
      if (json.success) setAssignments(json.data ?? []);
    } catch (err) {
      console.error("Failed to fetch assignments:", err);
    }
  }, []);

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/budgets?type=department");
      const json = await res.json();
      if (json.success && json.data?.departments) {
        setDepartments(json.data.departments.map((d: { department: string }) => d.department));
      }
    } catch (err) {
      console.error("Failed to fetch departments:", err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([fetchCatalog(), fetchGateways(), fetchDepartments()]);
      setLoading(false);
    };
    void load();
    const interval = setInterval(() => {
      void fetchGateways();
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchCatalog, fetchGateways, fetchDepartments]);

  useEffect(() => {
    if (selectedDept) void fetchAssignments(selectedDept);
  }, [selectedDept, fetchAssignments]);

  const handleAssign = async (catalogId: string, action: "assign" | "remove") => {
    if (!selectedDept) return;
    try {
      const res = await fetch("/api/admin/mcp/assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dept_id: selectedDept, catalog_id: catalogId, action }),
      });
      const json = await res.json();
      if (json.success) {
        await fetchAssignments(selectedDept);
        await fetchGateways();
      }
    } catch (err) {
      console.error("Failed to update assignment:", err);
    }
  };

  const handleCreateGateway = async (deptId: string) => {
    try {
      const res = await fetch("/api/admin/mcp/gateways", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dept_id: deptId }),
      });
      const json = await res.json();
      if (json.success) await fetchGateways();
    } catch (err) {
      console.error("Failed to create gateway:", err);
    }
  };

  const handleDeleteGateway = async (deptId: string) => {
    if (!confirm(`Delete gateway for ${deptId}? This will remove all MCP targets.`)) return;
    try {
      const res = await fetch("/api/admin/mcp/gateways", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dept_id: deptId }),
      });
      const json = await res.json();
      if (json.success) await fetchGateways();
    } catch (err) {
      console.error("Failed to delete gateway:", err);
    }
  };

  const handleSyncGateway = async (deptId: string) => {
    try {
      await fetch("/api/admin/mcp/gateways/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dept_id: deptId }),
      });
      await fetchGateways();
    } catch (err) {
      console.error("Failed to sync gateway:", err);
    }
  };

  if (loading) {
    return <div className="text-gray-400 text-center py-12">Loading MCP configuration...</div>;
  }

  const tabs: { id: TabType; label: string; count: number }[] = [
    { id: "catalog", label: "MCP Catalog", count: catalog.length },
    { id: "assignments", label: "Department Assignments", count: assignments.length },
    { id: "gateways", label: "Gateway Status", count: gateways.length },
  ];

  const deptCatalog = catalog.filter((c) => c.tier === "department" && c.enabled);
  const assignedIds = new Set(assignments.filter((a) => a.enabled).map((a) => a.catalogId));

  return (
    <div>
      {/* Tab navigation */}
      <div className="flex space-x-1 mb-6 bg-gray-800/50 rounded-lg p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab.label}
            <span className="ml-2 text-xs text-gray-500">({tab.count})</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "catalog" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {catalog.map((item) => (
              <div key={item.id} className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-100">{item.name}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    item.tier === "common" ? "bg-blue-500/20 text-blue-400" : "bg-gray-600/30 text-gray-300"
                  }`}>
                    {item.tier}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mb-3">{item.description}</p>
                <div className="flex items-center justify-between">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_COLORS[item.category] ?? "bg-gray-600/30 text-gray-300"}`}>
                    {item.category}
                  </span>
                  <span className="text-xs text-gray-500">
                    {item.toolSchema.length} tool{item.toolSchema.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "assignments" && (
        <div className="space-y-4">
          {/* Department selector */}
          <div className="flex items-center gap-4 mb-4">
            <select
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
              className="bg-gray-800 border border-gray-600 text-gray-200 rounded-md px-3 py-2 text-sm"
            >
              <option value="">Select department...</option>
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            {selectedDept && !gateways.some((g) => g.deptId === selectedDept && g.gatewayId) && (
              <button
                onClick={() => handleCreateGateway(selectedDept)}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm"
              >
                Create Gateway
              </button>
            )}
          </div>

          {selectedDept ? (
            <div className="space-y-3">
              {deptCatalog.map((item) => {
                const isAssigned = assignedIds.has(item.id);
                const assignment = assignments.find((a) => a.catalogId === item.id);
                return (
                  <div key={item.id} className="flex items-center justify-between bg-gray-800/50 rounded-lg p-3 border border-gray-700">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={isAssigned}
                        onChange={() => handleAssign(item.id, isAssigned ? "remove" : "assign")}
                        className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
                      />
                      <div>
                        <span className="text-sm text-gray-200">{item.name}</span>
                        <span className="ml-2 text-xs text-gray-500">{item.description}</span>
                      </div>
                    </div>
                    {assignment && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[assignment.status] ?? STATUS_COLORS.PENDING}`}>
                        {assignment.status}
                      </span>
                    )}
                  </div>
                );
              })}
              {deptCatalog.length === 0 && (
                <p className="text-gray-500 text-sm text-center py-8">No department-tier MCP items in catalog</p>
              )}
            </div>
          ) : (
            <p className="text-gray-500 text-sm text-center py-8">Select a department to manage MCP assignments</p>
          )}
        </div>
      )}

      {activeTab === "gateways" && (
        <div className="space-y-4">
          {gateways.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-8">No gateways configured</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-gray-400 uppercase bg-gray-800/30">
                  <tr>
                    <th className="px-4 py-3">Department</th>
                    <th className="px-4 py-3">Gateway Name</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Targets</th>
                    <th className="px-4 py-3">Last Sync</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {gateways.map((gw) => (
                    <tr key={gw.deptId} className="hover:bg-gray-800/30">
                      <td className="px-4 py-3">
                        <span className="font-medium text-gray-200">
                          {gw.deptId === "common" ? "Common (All)" : gw.deptId}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                        {gw.gatewayName || "-"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[gw.status] ?? STATUS_COLORS.PENDING}`}>
                          {gw.status}
                        </span>
                        {gw.errorMessage && (
                          <span className="ml-2 text-xs text-red-400" title={gw.errorMessage}>!</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-400">{gw.targetCount}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {gw.lastSyncAt ? new Date(gw.lastSyncAt).toLocaleString() : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleSyncGateway(gw.deptId)}
                            className="text-xs text-blue-400 hover:text-blue-300"
                          >
                            Re-sync
                          </button>
                          {gw.deptId !== "common" && (
                            <button
                              onClick={() => handleDeleteGateway(gw.deptId)}
                              className="text-xs text-red-400 hover:text-red-300"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
