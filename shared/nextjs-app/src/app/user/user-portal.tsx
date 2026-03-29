"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import type { UserSession, ContainerInfo, UserPortalTab } from "@/lib/types";
import EnvironmentTab from "@/components/user/environment-tab";
import StorageTab from "@/components/user/storage-tab";
import SettingsTab from "@/components/user/settings-tab";

interface UserPortalProps {
  user: UserSession;
}

const TABS: { id: UserPortalTab; label: string; icon: React.ReactNode }[] = [
  {
    id: "environment",
    label: "Environment",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: "storage",
    label: "Storage",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export default function UserPortal({ user }: UserPortalProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<UserPortalTab>("environment");
  const [container, setContainer] = useState<ContainerInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchContainerStatus = useCallback(async () => {
    try {
      const containersRes = await fetch("/api/containers");
      const containersData = await containersRes.json();
      if (containersData.success && Array.isArray(containersData.data)) {
        const userContainer = containersData.data.find(
          (c: ContainerInfo) =>
            c.subdomain === user.subdomain &&
            (c.status === "RUNNING" || c.status === "PENDING" || c.status === "PROVISIONING")
        );
        setContainer(userContainer ?? null);
      }
    } catch (err) {
      console.error("Failed to fetch container status:", err);
    } finally {
      setLoading(false);
    }
  }, [user.subdomain]);

  useEffect(() => {
    fetchContainerStatus();
    const interval = setInterval(fetchContainerStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchContainerStatus]);

  if (loading && !container) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">{t("analytics.loading")}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Tab Navigation */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800">
        <div className="flex border-b border-gray-800">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-6 py-3.5 text-sm font-medium transition-all border-b-2 ${
                activeTab === tab.id
                  ? "border-blue-500 text-blue-400 bg-blue-900/10"
                  : "border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "environment" && (
        <EnvironmentTab
          user={user}
          container={container}
          setContainer={setContainer}
          fetchData={fetchContainerStatus}
        />
      )}
      {activeTab === "storage" && (
        <StorageTab user={user} container={container} />
      )}
      {activeTab === "settings" && (
        <SettingsTab user={user} container={container} />
      )}
    </div>
  );
}
