"use client";

import { useState, useEffect, useCallback } from "react";

type McpItem = {
  mcpId: string;
  name: string;
  description: string;
  category: string;
  lambdaArn: string;
  tools: string[];
  enabled: boolean;
};

type Assignment = {
  mcpId: string;
  department: string;
  enabled: boolean;
  assignedAt: string;
};

type Gateway = {
  department: string;
  gatewayId: string;
  gatewayUrl: string;
  status: string;
  createdAt: string;
  lastSyncAt: string;
};

type Tab = "catalog" | "assignments" | "gateways";

export default function McpManagement() {
  const [tab, setTab] = useState<Tab>("catalog");
  const [catalog, setCatalog] = useState<McpItem[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [selectedDept, setSelectedDept] = useState("");
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<McpItem | null>(null);
  const [form, setForm] = useState({
    mcpId: "", name: "", description: "", category: "department", lambdaArn: "", tools: "",
  });

  const fetchCatalog = useCallback(async () => {
    const res = await fetch("/api/admin/mcp/catalog");
    const data = await res.json();
    if (data.success) setCatalog(data.data);
  }, []);

  const fetchGateways = useCallback(async () => {
    const res = await fetch("/api/admin/mcp/gateways");
    const data = await res.json();
    if (data.success) setGateways(data.data);
  }, []);

  const fetchAssignments = useCallback(async (dept: string) => {
    if (!dept) return;
    const res = await fetch(`/api/admin/mcp/assignments?department=${dept}`);
    const data = await res.json();
    if (data.success) setAssignments(data.data);
  }, []);

  useEffect(() => {
    fetchCatalog();
    fetchGateways();
  }, [fetchCatalog, fetchGateways]);

  useEffect(() => {
    if (selectedDept) fetchAssignments(selectedDept);
  }, [selectedDept, fetchAssignments]);

  const handleAssign = async (mcpId: string, action: "assign" | "remove") => {
    setLoading(true);
    await fetch("/api/admin/mcp/assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ department: selectedDept, mcpId, action }),
    });
    await fetchAssignments(selectedDept);
    setLoading(false);
  };

  const handleCreateGateway = async (department: string) => {
    setLoading(true);
    await fetch("/api/admin/mcp/gateways", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ department }),
    });
    await fetchGateways();
    setLoading(false);
  };

  const handleDeleteGateway = async (department: string) => {
    if (!confirm(`Delete gateway for ${department}?`)) return;
    setLoading(true);
    await fetch("/api/admin/mcp/gateways", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ department }),
    });
    await fetchGateways();
    setLoading(false);
  };

  const handleSync = async (department: string) => {
    setLoading(true);
    await fetch("/api/admin/mcp/gateways/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ department }),
    });
    setLoading(false);
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "catalog", label: "MCP Catalog" },
    { key: "assignments", label: "Department Assignments" },
    { key: "gateways", label: "Gateway Status" },
  ];

  const statusColor = (s: string) => {
    if (s === "ACTIVE") return "bg-green-500/20 text-green-400";
    if (s === "CREATING") return "bg-yellow-500/20 text-yellow-400";
    if (s === "DELETING") return "bg-red-500/20 text-red-400";
    return "bg-gray-500/20 text-gray-400";
  };

  const assignedMcpIds = new Set(assignments.filter((a) => a.enabled).map((a) => a.mcpId));

  const openCreateModal = () => {
    setEditItem(null);
    setForm({ mcpId: "", name: "", description: "", category: "department", lambdaArn: "", tools: "" });
    setShowModal(true);
  };

  const openEditModal = (item: McpItem) => {
    setEditItem(item);
    setForm({
      mcpId: item.mcpId,
      name: item.name,
      description: item.description,
      category: item.category,
      lambdaArn: item.lambdaArn,
      tools: item.tools.join(", "),
    });
    setShowModal(true);
  };

  const handleSubmitCatalog = async () => {
    setLoading(true);
    const toolsArray = form.tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (editItem) {
      await fetch("/api/admin/mcp/catalog", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mcpId: editItem.mcpId,
          name: form.name,
          description: form.description,
          category: form.category,
          lambdaArn: form.lambdaArn,
          tools: toolsArray,
        }),
      });
    } else {
      await fetch("/api/admin/mcp/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mcpId: form.mcpId,
          name: form.name,
          description: form.description,
          category: form.category,
          lambdaArn: form.lambdaArn,
          tools: toolsArray,
        }),
      });
    }

    await fetchCatalog();
    setShowModal(false);
    setLoading(false);
  };

  return (
    <div>
      {/* Tabs */}
      <div role="tablist" className="flex gap-1 mb-6 border-b border-gray-700">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Catalog Tab */}
      {tab === "catalog" && (
        <div>
          <div className="mb-4 flex justify-end">
            <button
              onClick={openCreateModal}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
            >
              + Add MCP
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {catalog.map((item) => (
            <div
              key={item.mcpId}
              onClick={() => openEditModal(item)}
              className="bg-gray-800 rounded-lg p-4 border border-gray-700 cursor-pointer hover:border-gray-500 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-100">{item.name}</h3>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-medium ${
                    item.category === "common"
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-purple-500/20 text-purple-400"
                  }`}
                >
                  {item.category}
                </span>
              </div>
              <p className="text-xs text-gray-400 mb-3">{item.description}</p>
              {item.tools.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {item.tools.map((tool) => (
                    <span
                      key={tool}
                      className="px-1.5 py-0.5 bg-gray-700 rounded text-xs text-gray-300"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {catalog.length === 0 && (
            <p className="text-gray-500 col-span-3 text-center py-8">
              No MCP items in catalog. Run seed-mcp-catalog.py to populate.
            </p>
          )}
          </div>
        </div>
      )}

      {/* Assignments Tab */}
      {tab === "assignments" && (
        <div>
          <div className="mb-4 flex gap-3 items-center">
            <label htmlFor="dept-select" className="text-sm text-gray-300">
              Department:
            </label>
            <select
              id="dept-select"
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
              className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200"
            >
              <option value="">Select department</option>
              {gateways.map((gw) => (
                <option key={gw.department} value={gw.department}>
                  {gw.department}
                </option>
              ))}
            </select>
          </div>

          {selectedDept ? (
            <div className="space-y-2">
              {catalog.map((item) => (
                <div
                  key={item.mcpId}
                  className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-3 border border-gray-700"
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id={`assign-${item.mcpId}`}
                      checked={assignedMcpIds.has(item.mcpId)}
                      onChange={() =>
                        handleAssign(
                          item.mcpId,
                          assignedMcpIds.has(item.mcpId) ? "remove" : "assign"
                        )
                      }
                      disabled={loading}
                      className="w-4 h-4 rounded border-gray-600 bg-gray-700"
                    />
                    <label
                      htmlFor={`assign-${item.mcpId}`}
                      className="text-sm text-gray-200"
                    >
                      {item.name}
                    </label>
                    <span className="text-xs text-gray-500">{item.description}</span>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      item.category === "common"
                        ? "bg-blue-500/20 text-blue-400"
                        : "bg-purple-500/20 text-purple-400"
                    }`}
                  >
                    {item.category}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 text-center py-8">
              Select a department to manage MCP assignments
            </p>
          )}
        </div>
      )}

      {/* Gateways Tab */}
      {tab === "gateways" && (
        <div>
          <div className="mb-4 flex justify-end">
            <button
              onClick={() => {
                const dept = prompt("Department name:");
                if (dept) handleCreateGateway(dept);
              }}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
              disabled={loading}
            >
              + Create Gateway
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="pb-2 pr-4">Department</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Gateway ID</th>
                  <th className="pb-2 pr-4">Created</th>
                  <th className="pb-2 pr-4">Last Sync</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {gateways.map((gw) => (
                  <tr key={gw.department} className="border-b border-gray-800">
                    <td className="py-2 pr-4 text-gray-200 font-medium">
                      {gw.department}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(gw.status)}`}
                      >
                        {gw.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-400 text-xs font-mono">
                      {gw.gatewayId || "—"}
                    </td>
                    <td className="py-2 pr-4 text-gray-400 text-xs">
                      {gw.createdAt ? new Date(gw.createdAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="py-2 pr-4 text-gray-400 text-xs">
                      {gw.lastSyncAt ? new Date(gw.lastSyncAt).toLocaleString() : "—"}
                    </td>
                    <td className="py-2 flex gap-2">
                      <button
                        onClick={() => handleSync(gw.department)}
                        className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"
                        disabled={loading}
                      >
                        Sync
                      </button>
                      <button
                        onClick={() => handleDeleteGateway(gw.department)}
                        className="px-2 py-1 text-xs bg-red-900/50 hover:bg-red-900 text-red-400 rounded"
                        disabled={loading}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {gateways.length === 0 && (
              <p className="text-gray-500 text-center py-8">
                No gateways created yet
              </p>
            )}
          </div>
        </div>
      )}

      {/* Add / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-lg border border-gray-700">
            <h2 className="text-lg font-semibold text-gray-100 mb-4">
              {editItem ? "Edit MCP" : "Add MCP"}
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmitCatalog();
              }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="modal-mcpId" className="block text-sm text-gray-300 mb-1">
                  MCP ID
                </label>
                <input
                  id="modal-mcpId"
                  type="text"
                  required
                  disabled={!!editItem}
                  value={form.mcpId}
                  onChange={(e) => setForm({ ...form, mcpId: e.target.value })}
                  placeholder="e.g. jira-tools"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 disabled:opacity-50"
                />
              </div>
              <div>
                <label htmlFor="modal-name" className="block text-sm text-gray-300 mb-1">
                  Name
                </label>
                <input
                  id="modal-name"
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Jira Integration"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200"
                />
              </div>
              <div>
                <label htmlFor="modal-desc" className="block text-sm text-gray-300 mb-1">
                  Description
                </label>
                <input
                  id="modal-desc"
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Short description"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200"
                />
              </div>
              <div>
                <label htmlFor="modal-category" className="block text-sm text-gray-300 mb-1">
                  Category
                </label>
                <select
                  id="modal-category"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200"
                >
                  <option value="common">Common</option>
                  <option value="department">Department</option>
                </select>
              </div>
              <div>
                <label htmlFor="modal-arn" className="block text-sm text-gray-300 mb-1">
                  Lambda ARN
                </label>
                <input
                  id="modal-arn"
                  type="text"
                  value={form.lambdaArn}
                  onChange={(e) => setForm({ ...form, lambdaArn: e.target.value })}
                  placeholder="arn:aws:lambda:..."
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200"
                />
              </div>
              <div>
                <label htmlFor="modal-tools" className="block text-sm text-gray-300 mb-1">
                  Tools (comma-separated)
                </label>
                <input
                  id="modal-tools"
                  type="text"
                  value={form.tools}
                  onChange={(e) => setForm({ ...form, tools: e.target.value })}
                  placeholder="list_issues, create_ticket, search"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors disabled:opacity-50"
                >
                  {loading ? "Saving..." : editItem ? "Update" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
