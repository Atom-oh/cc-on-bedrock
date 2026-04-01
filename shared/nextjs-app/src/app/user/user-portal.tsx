"use client";

import { useState, useEffect, useCallback, useRef, KeyboardEvent } from "react";
import { useI18n } from "@/lib/i18n";
import type { UserSession, ContainerInfo, UserPortalTab } from "@/lib/types";
import EnvironmentTab from "@/components/user/environment-tab";
import StorageTab from "@/components/user/storage-tab";
import SettingsTab from "@/components/user/settings-tab";
import WelcomeOnboarding from "@/components/user/welcome-onboarding";
import FirstLaunchGuide from "@/components/user/first-launch-guide";

interface UserPortalProps {
  user: UserSession;
}

const TABS: { id: UserPortalTab; label: string; shortLabel: string; icon: React.ReactNode }[] = [
  {
    id: "environment",
    label: "Environment",
    shortLabel: "Env",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: "storage",
    label: "Storage",
    shortLabel: "Disk",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    shortLabel: "Set",
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
  const [hasEverStarted, setHasEverStarted] = useState(true); // assume yes until proven otherwise
  const [animating, setAnimating] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const fetchContainerStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/user/container");
      const data = await res.json();
      if (data.success) {
        setContainer(data.data ?? null);
      }
    } catch (err) {
      console.error("Failed to fetch container status:", err);
    } finally {
      setLoading(false);
    }
  }, [user.subdomain]);

  useEffect(() => {
    fetchContainerStatus();
    // Fast polling (5s) when container is starting, normal (30s) when healthy/idle
    const pollInterval = container && container.status !== "STOPPED" && container.healthStatus !== "HEALTHY" ? 5000 : 30000;
    const interval = setInterval(fetchContainerStatus, pollInterval);
    return () => clearInterval(interval);
  }, [fetchContainerStatus, container?.status, container?.healthStatus]);

  const switchTab = useCallback((tabId: UserPortalTab) => {
    if (tabId === activeTab) return;
    setAnimating(true);
    setTimeout(() => {
      setActiveTab(tabId);
      setTimeout(() => setAnimating(false), 20);
    }, 100);
  }, [activeTab]);

  const handleTabKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = currentIndex;

    if (e.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % TABS.length;
      e.preventDefault();
    } else if (e.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
      e.preventDefault();
    } else if (e.key === "Home") {
      nextIndex = 0;
      e.preventDefault();
    } else if (e.key === "End") {
      nextIndex = TABS.length - 1;
      e.preventDefault();
    }

    if (nextIndex !== currentIndex) {
      switchTab(TABS[nextIndex].id);
      tabRefs.current[nextIndex]?.focus();
    }
  }, [activeTab, switchTab]);

  if (loading && !container) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">{t("analytics.loading")}</div>
      </div>
    );
  }

  // Onboarding: no subdomain assigned yet
  if (!user.subdomain) {
    return <WelcomeOnboarding email={user.email} />;
  }

  // First launch: subdomain assigned but never started a container
  if (!container && !loading && !hasEverStarted) {
    return (
      <FirstLaunchGuide
        subdomain={user.subdomain}
        onStart={() => switchTab("environment")}
        loading={false}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Tab Navigation */}
      <div className="bg-[#161b22] rounded-xl border border-gray-800">
        <div className="flex overflow-x-auto border-b border-gray-800" role="tablist" aria-label="User portal tabs">
          {TABS.map((tab, index) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(el) => { tabRefs.current[index] = el; }}
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`tabpanel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => switchTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                className={`flex items-center gap-2 px-4 sm:px-6 py-3.5 text-sm font-medium transition-all border-b-2 whitespace-nowrap ${
                  isActive
                    ? "border-blue-500 text-blue-400 bg-blue-900/10"
                    : "border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30"
                }`}
              >
                {tab.icon}
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div
        className={`transition-opacity duration-150 ${animating ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0"}`}
        style={{ transition: "opacity 150ms ease, transform 150ms ease" }}
      >
        {activeTab === "environment" && (
          <div role="tabpanel" id="tabpanel-environment" aria-labelledby="tab-environment">
            <EnvironmentTab
              user={user}
              container={container}
              setContainer={setContainer}
              fetchData={fetchContainerStatus}
            />
          </div>
        )}
        {activeTab === "storage" && (
          <div role="tabpanel" id="tabpanel-storage" aria-labelledby="tab-storage">
            <StorageTab user={user} container={container} />
          </div>
        )}
        {activeTab === "settings" && (
          <div role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings">
            <SettingsTab user={user} container={container} />
          </div>
        )}
      </div>
    </div>
  );
}
