"use client";

import { useState, useEffect, useCallback, useRef, KeyboardEvent } from "react";
import { useI18n } from "@/lib/i18n";
import type { UserSession, ContainerInfo, UserPortalTab } from "@/lib/types";
import EnvironmentTab from "@/components/user/environment-tab";
import StorageTab from "@/components/user/storage-tab";
import SettingsTab from "@/components/user/settings-tab";
import WelcomeOnboarding from "@/components/user/welcome-onboarding";
import LocalSetup from "@/components/user/local-setup";
import BudgetIncreaseRequest from "@/components/budget/budget-increase-request";
import { useDeploymentMode } from "@/components/deployment-mode-provider";
import { PortalStatusError, readContainerStatus } from "@/lib/portal-status";

// ADR-006 (legacy ADR-014): Local Governance Mode (Claude Code on local PC via STS). Tab visible
// when NEXT_PUBLIC_LOCAL_MODE_ENABLED=true is set on the Dashboard container.
const LOCAL_MODE_ENABLED =
  (process.env.NEXT_PUBLIC_LOCAL_MODE_ENABLED ?? "").toLowerCase() === "true";

interface UserPortalProps {
  user: UserSession;
  runtimeConfig: {
    domainName: string;
    devSubdomain: string;
  };
}

const ALL_TABS: { id: UserPortalTab; label: string; shortLabel: string; icon: React.ReactNode }[] = [
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

// ADR-006 (legacy ADR-014): Local (Bedrock) was a separate tab — now merged into Environment.
// Keeping ALL_TABS → TABS without filtering for now (local tab removed entirely).
const TABS = ALL_TABS;

// Governance mode has no EC2 DevEnv: the portal is the local installer and usage panel.
export default function UserPortal(props: UserPortalProps) {
  const deploymentMode = useDeploymentMode();
  if (deploymentMode !== "devenv") {
    return (
      <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
        <LocalSetup />
      </div>
    );
  }
  return <DevenvPortal {...props} />;
}

function DevenvPortal({ user, runtimeConfig }: UserPortalProps) {
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<UserPortalTab>("environment");
  const [container, setContainer] = useState<ContainerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [statusError, setStatusError] = useState<"session" | "unavailable" | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const [animating, setAnimating] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const fetchContainerStatus = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    const sequence = ++requestSequence.current;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setRefreshing(true);
    try {
      const res = await fetch("/api/user/container", { signal: controller.signal, cache: "no-store" });
      const data = await readContainerStatus(res);
      if (sequence !== requestSequence.current) return;
      setContainer(data);
      setHasLoaded(true);
      setStatusError(null);
      setLastUpdated(new Date());
    } catch (err) {
      if (sequence !== requestSequence.current) return;
      setStatusError(err instanceof PortalStatusError && err.status === 401 ? "session" : "unavailable");
    } finally {
      clearTimeout(timeout);
      if (sequence === requestSequence.current) {
        statusRequest.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [user.subdomain]);

  useEffect(() => {
    void fetchContainerStatus();
    return () => {
      ++requestSequence.current;
      statusRequest.current?.abort();
    };
  }, [fetchContainerStatus]);

  useEffect(() => {
    // Fast polling (5s) when container is starting, normal (30s) when healthy/idle
    const transitioning = container && (
      ["PENDING", "PROVISIONING", "STOPPING"].includes(container.status) ||
      (container.status === "RUNNING" && container.healthStatus !== "HEALTHY")
    );
    const pollInterval = transitioning ? 5000 : 30000;
    const interval = setInterval(() => {
      if (!statusRequest.current) void fetchContainerStatus();
    }, pollInterval);
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
      <div className="flex items-center justify-center h-64" role="status">
        <div className="text-gray-400">{t("analytics.loading")}</div>
      </div>
    );
  }

  // Onboarding: no subdomain assigned yet.
  // - LOCAL_MODE_ENABLED: fall through to Environment tab (now hosts Local section
  //   at the top above the Container Request flow).
  // - Otherwise: show classic welcome onboarding.
  if (!user.subdomain && !LOCAL_MODE_ENABLED) {
    return <WelcomeOnboarding email={user.email} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-gray-400" aria-live="polite">
          {lastUpdated ? `${t("user.lastUpdated")}: ${lastUpdated.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US")}` : t("user.statusUnknown")}
        </span>
        <button onClick={fetchContainerStatus} disabled={refreshing}
          className="rounded-lg border border-gray-700 px-3 py-2 text-gray-200 hover:bg-gray-800 disabled:opacity-50">
          {refreshing ? t("user.refreshing") : t("user.refreshStatus")}
        </button>
      </div>
      {statusError && (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-900/20 p-4 text-sm text-amber-200">
          <p>{t(statusError === "session" ? "user.sessionExpired" : hasLoaded ? "user.statusStale" : "user.statusUnavailable")}</p>
          {statusError === "session" && (
            <a href="/login?callbackUrl=%2Fuser" className="mt-2 inline-block underline">{t("user.signInAgain")}</a>
          )}
        </div>
      )}
      {hasLoaded && <>
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
                <span>{t(`user.tab.${tab.id}`)}</span>
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
              domainName={runtimeConfig.domainName}
              devSubdomain={runtimeConfig.devSubdomain}
              statusVerified={!statusError}
            />
            {/* One-time budget increase request + history (both editions, spec §5.1) */}
            <div className="mt-6">
              <BudgetIncreaseRequest />
            </div>
          </div>
        )}
        {activeTab === "storage" && (
          <div role="tabpanel" id="tabpanel-storage" aria-labelledby="tab-storage">
            <StorageTab user={user} container={container} />
          </div>
        )}
        {activeTab === "settings" && (
          <div role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings">
            <SettingsTab
              user={user}
              container={container}
              domainName={runtimeConfig.domainName}
              devSubdomain={runtimeConfig.devSubdomain}
            />
          </div>
        )}
      </div>
      </>}
    </div>
  );
}
