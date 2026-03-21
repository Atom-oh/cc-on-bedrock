"use client";

import { useState, useEffect, useCallback } from "react";
import HealthCard from "@/components/cards/health-card";
import StatCard from "@/components/cards/stat-card";
import ContainersTable from "@/components/tables/containers-table";
import type { HealthStatus, ContainerInfo, ApiResponse } from "@/lib/types";

interface MonitoringDashboardProps {
  domainName?: string;
  devSubdomain?: string;
}

export default function MonitoringDashboard({
  domainName = "example.com",
  devSubdomain = "dev",
}: MonitoringDashboardProps) {
  const [healthStatuses, setHealthStatuses] = useState<HealthStatus[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch health status
      const healthRes = await fetch("/api/health");
      const healthJson = (await healthRes.json()) as {
        status: string;
        checks: Record<string, { status: string; message?: string }>;
        timestamp: string;
      };

      const statuses: HealthStatus[] = Object.entries(
        healthJson.checks
      ).map(([service, check]) => ({
        service: service.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        status: check.status as HealthStatus["status"],
        message: check.message,
        lastChecked: healthJson.timestamp,
      }));
      setHealthStatuses(statuses);

      // Fetch containers
      const containersRes = await fetch("/api/containers");
      const containersJson = (await containersRes.json()) as ApiResponse<
        ContainerInfo[]
      >;
      setContainers(containersJson.data ?? []);
    } catch (err) {
      console.error("Failed to fetch monitoring data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    // Auto-refresh every 30 seconds
    const interval = setInterval(() => void fetchData(), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const runningContainers = containers.filter(
    (c) => c.status === "RUNNING"
  );
  const pendingContainers = containers.filter(
    (c) => c.status === "PENDING" || c.status === "PROVISIONING"
  );

  const handleStopContainer = async (taskArn: string) => {
    if (!confirm("Are you sure you want to stop this container?")) return;
    try {
      await fetch("/api/containers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskArn }),
      });
      void fetchData();
    } catch (err) {
      console.error("Failed to stop container:", err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-500">Loading monitoring data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Service Health */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4">
          Service Health
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {healthStatuses.map((hs) => (
            <HealthCard key={hs.service} {...hs} />
          ))}
        </div>
      </section>

      {/* Container Stats */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4">
          Container Overview
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            title="Running Containers"
            value={runningContainers.length}
            description="Active dev environments"
          />
          <StatCard
            title="Pending Containers"
            value={pendingContainers.length}
            description="Starting up"
          />
          <StatCard
            title="Total Containers"
            value={containers.length}
            description="All states"
          />
        </div>
      </section>

      {/* Active Sessions */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-100">
            Active Sessions
          </h2>
          <button
            onClick={() => void fetchData()}
            className="px-3 py-1.5 text-sm font-medium text-gray-300 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700"
          >
            Refresh
          </button>
        </div>
        <ContainersTable
          containers={containers}
          onStop={handleStopContainer}
          domainName={domainName}
          devSubdomain={devSubdomain}
        />
      </section>
    </div>
  );
}
