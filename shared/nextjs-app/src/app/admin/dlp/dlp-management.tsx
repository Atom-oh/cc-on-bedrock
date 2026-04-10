"use client";

import { useState, useEffect, useCallback } from "react";

interface DomainListMeta {
  name: string;
  listType: "ALLOW" | "DENY";
  tier: string;
  firewallDomainListId: string;
  domainCount: number;
  status: string;
  createdAt: string;
  createdBy: string;
}

interface DomainEntry {
  domain: string;
  addedAt: string;
  addedBy: string;
}

const DEFAULT_ALLOWLIST = [
  "github.com", "*.github.com", "*.githubusercontent.com",
  "npmjs.org", "*.npmjs.org", "registry.npmjs.org",
  "pypi.org", "*.pypi.org", "files.pythonhosted.org",
  "ubuntu.com", "*.ubuntu.com", "*.archive.ubuntu.com",
  "*.amazonaws.com", "*.amazoncognito.com",
  "dl.google.com", "*.docker.io", "*.docker.com",
  "*.cloudfront.net", "*.awsstatic.com",
];

export default function DlpManagement() {
  const [lists, setLists] = useState<DomainListMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [expandedList, setExpandedList] = useState<string | null>(null);
  const [domains, setDomains] = useState<DomainEntry[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"ALLOW" | "DENY">("ALLOW");
  const [newTier, setNewTier] = useState<"restricted" | "locked">("restricted");
  const [newDomains, setNewDomains] = useState("");
  const [creating, setCreating] = useState(false);

  // Add domain state
  const [addDomainInput, setAddDomainInput] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);

  const fetchLists = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/dlp/domains?action=lists");
      const json = await res.json();
      if (json.success) setLists(json.data ?? []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchLists(); }, [fetchLists]);

  const fetchDomains = async (listId: string) => {
    setDomainsLoading(true);
    try {
      const res = await fetch(`/api/admin/dlp/domains?action=domains&listId=${listId}`);
      const json = await res.json();
      if (json.success) setDomains(json.data ?? []);
    } catch { /* ignore */ }
    finally { setDomainsLoading(false); }
  };

  const handleExpand = (listId: string) => {
    if (expandedList === listId) {
      setExpandedList(null);
      setDomains([]);
    } else {
      setExpandedList(listId);
      fetchDomains(listId);
    }
  };

  const handleCreate = async () => {
    setError(null);
    if (!newName.trim()) { setError("Name is required"); return; }
    const domainLines = newDomains.split("\n").map((d) => d.trim()).filter(Boolean);
    if (domainLines.length === 0) { setError("At least one domain is required"); return; }

    setCreating(true);
    try {
      const res = await fetch("/api/admin/dlp/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, listType: newType, tier: newTier, domains: domainLines }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setSuccess(`Domain list "${newName}" created with ${json.data.domainCount} domains`);
        setShowCreate(false);
        setNewName("");
        setNewDomains("");
        fetchLists();
      } else {
        setError(json.error ?? "Failed to create");
      }
    } catch { setError("Network error"); }
    finally { setCreating(false); }
  };

  const handleAddDomain = async (listId: string) => {
    if (!addDomainInput.trim()) return;
    const newDoms = addDomainInput.split(",").map((d) => d.trim()).filter(Boolean);
    setAddingDomain(true);
    try {
      const res = await fetch("/api/admin/dlp/domains", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId, action: "ADD", domains: newDoms }),
      });
      if (res.ok) {
        setAddDomainInput("");
        fetchDomains(listId);
        fetchLists();
      }
    } catch { /* ignore */ }
    finally { setAddingDomain(false); }
  };

  const handleRemoveDomain = async (listId: string, domain: string) => {
    if (!confirm(`Remove "${domain}" from this list?`)) return;
    try {
      await fetch("/api/admin/dlp/domains", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId, action: "REMOVE", domains: [domain] }),
      });
      fetchDomains(listId);
      fetchLists();
    } catch { /* ignore */ }
  };

  const handleDeleteList = async (listId: string, name: string) => {
    if (!confirm(`Delete domain list "${name}"? This will remove the DNS Firewall rule.`)) return;
    try {
      const res = await fetch("/api/admin/dlp/domains", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId }),
      });
      if (res.ok) {
        setSuccess(`Domain list "${name}" deleted`);
        setExpandedList(null);
        fetchLists();
      }
    } catch { setError("Failed to delete"); }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  }

  return (
    <div className="space-y-6">
      {error && <div className="bg-red-900/30 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg text-sm">{error}</div>}
      {success && <div className="bg-green-900/30 border border-green-500/30 text-green-400 px-4 py-3 rounded-lg text-sm">{success}</div>}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">{lists.length} domain list(s)</span>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {showCreate ? "Cancel" : "Create Domain List"}
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6 space-y-4">
          <h3 className="text-sm font-semibold text-gray-200">New Domain List</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Name</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Restricted Allowlist"
                className="w-full bg-[#0d1117] border border-gray-700 rounded-lg p-2 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Type</label>
              <select value={newType} onChange={(e) => setNewType(e.target.value as "ALLOW" | "DENY")}
                className="w-full bg-[#0d1117] border border-gray-700 rounded-lg p-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none">
                <option value="ALLOW">ALLOW (Whitelist)</option>
                <option value="DENY">DENY (Blacklist)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">DLP Tier</label>
              <select value={newTier} onChange={(e) => setNewTier(e.target.value as "restricted" | "locked")}
                className="w-full bg-[#0d1117] border border-gray-700 rounded-lg p-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none">
                <option value="restricted">Restricted</option>
                <option value="locked">Locked</option>
              </select>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-gray-500">Domains (one per line)</label>
              <button onClick={() => setNewDomains(DEFAULT_ALLOWLIST.join("\n"))}
                className="text-[10px] text-blue-400 hover:text-blue-300">
                Load default allowlist template
              </button>
            </div>
            <textarea value={newDomains} onChange={(e) => setNewDomains(e.target.value)}
              rows={8}
              placeholder={"github.com\n*.npmjs.org\npypi.org"}
              className="w-full bg-[#0d1117] border border-gray-700 rounded-lg p-3 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none font-mono" />
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">{newDomains.split("\n").filter(Boolean).length} domain(s)</p>
            <button onClick={handleCreate} disabled={creating}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors">
              {creating ? "Creating..." : "Create List"}
            </button>
          </div>
        </div>
      )}

      {/* Domain Lists */}
      {lists.length === 0 && !showCreate ? (
        <div className="bg-[#161b22] rounded-xl border border-gray-800 p-12 text-center">
          <p className="text-gray-500 text-sm">No domain lists configured yet.</p>
          <p className="text-gray-600 text-xs mt-1">Create an ALLOW list for the Restricted tier to whitelist trusted domains.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {lists.map((list) => {
            const listId = list.firewallDomainListId;
            const isExpanded = expandedList === listId;
            return (
              <div key={listId} className="bg-[#161b22] rounded-xl border border-gray-800">
                {/* List Header */}
                <div className="p-5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button onClick={() => handleExpand(listId)} className="text-left flex items-center gap-3">
                      <svg className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <div>
                        <p className="text-sm font-medium text-gray-200">{list.name}</p>
                        <p className="text-[10px] text-gray-500">{list.createdBy} · {new Date(list.createdAt).toLocaleDateString()}</p>
                      </div>
                    </button>
                    <span className={`px-2 py-0.5 text-[10px] font-semibold rounded ${list.listType === "ALLOW" ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>
                      {list.listType}
                    </span>
                    <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-blue-900/30 text-blue-400 capitalize">
                      {list.tier}
                    </span>
                    <span className="text-xs text-gray-500">{list.domainCount} domains</span>
                  </div>
                  <button onClick={() => handleDeleteList(listId, list.name)}
                    className="px-3 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded-lg transition-colors">
                    Delete
                  </button>
                </div>

                {/* Expanded Domain List */}
                {isExpanded && (
                  <div className="border-t border-gray-800 p-5 space-y-3">
                    {/* Add domain input */}
                    <div className="flex gap-2">
                      <input
                        value={addDomainInput}
                        onChange={(e) => setAddDomainInput(e.target.value)}
                        placeholder="Add domain (comma-separated for multiple)"
                        className="flex-1 bg-[#0d1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                        onKeyDown={(e) => { if (e.key === "Enter") handleAddDomain(listId); }}
                      />
                      <button onClick={() => handleAddDomain(listId)} disabled={addingDomain}
                        className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded-lg transition-colors">
                        {addingDomain ? "..." : "Add"}
                      </button>
                    </div>

                    {/* Domain list */}
                    {domainsLoading ? (
                      <p className="text-xs text-gray-500 py-2">Loading domains...</p>
                    ) : (
                      <div className="max-h-64 overflow-y-auto space-y-1">
                        {domains.map((d) => (
                          <div key={d.domain} className="flex items-center justify-between bg-[#0d1117] rounded-lg px-3 py-2 group">
                            <code className="text-xs text-gray-300 font-mono">{d.domain}</code>
                            <button onClick={() => handleRemoveDomain(listId, d.domain)}
                              className="text-[10px] text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                              Remove
                            </button>
                          </div>
                        ))}
                        {domains.length === 0 && <p className="text-xs text-gray-600 py-2">No domains in this list.</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
