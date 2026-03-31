"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useI18n } from "@/lib/i18n";
import {
  RefreshCw,
  ChevronRight,
  ArrowUpRight,
  Shield,
  Database,
  Layers,
  Layout as LayoutIcon,
  Cpu,
  Zap,
  BarChart3,
  Activity
} from "lucide-react";
import type { ContainerInfo, ApiResponse } from "@/lib/types";
import StatCard from "@/components/cards/stat-card";
import { cn } from "@/lib/utils";

interface HomeDashboardProps {
  isAdmin: boolean;
}

interface SystemHealth {
  status: string;
  db: string;
  cache: string;
  architecture: string;
  model_count: number;
}

interface ContainerCWMetrics {
  cpuUtilized: number;
  cpuReserved: number;
  cpuUtilizationPct: number;
  memoryUtilized: number;
  memoryReserved: number;
  memoryUtilizationPct: number;
  networkRxBytes: number;
  networkTxBytes: number;
  taskCount: number;
  containerInstanceCount: number;
}

function formatCost(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(2)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function formatNum(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(v < 10 && v > 0 ? 2 : 0);
}

const SectionHeader = ({ title, subtitle, icon: Icon, action }: any) => (
  <div className="flex items-end justify-between mb-6 group">
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-lg bg-primary-500/10 text-primary-400 group-hover:scale-110 transition-transform duration-300">
          <Icon className="w-4 h-4" />
        </div>
        <h2 className="text-sm font-black text-white uppercase tracking-widest leading-none">
          {title}
        </h2>
      </div>
      <p className="text-xs font-bold text-gray-500 uppercase tracking-tighter">
        {subtitle}
      </p>
    </div>
    {action}
  </div>
);

export default function HomeDashboard({ isAdmin }: HomeDashboardProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<{
    totalCost: number;
    totalTokens: number;
    activeContainers: number;
    containers: ContainerInfo[];
    cwMetrics: ContainerCWMetrics | null;
    health: SystemHealth | null;
  }>({
    totalCost: 0,
    totalTokens: 0,
    activeContainers: 0,
    containers: [],
    cwMetrics: null,
    health: null,
  });

  const fetchData = useCallback(async () => {
    try {
      setRefreshing(true);
      const [containerRes, cwRes, healthRes, usageRes] = await Promise.all([
        fetch("/api/containers"),
        fetch("/api/container-metrics?action=current"),
        fetch("/api/health"),
        fetch(`/api/usage?period=daily&date=${new Date().toISOString().split("T")[0]}`),
      ]);

      const containers: ApiResponse<ContainerInfo[]> = await containerRes.json();
      const cw = await cwRes.json();
      const health = await healthRes.json();
      const usage = await usageRes.json();

      const activeContainers = containers.data?.filter((c: ContainerInfo) => c.status === "RUNNING").length || 0;
      const totalTokens = usage.data?.totalTokens ?? 0;
      const totalCost = usage.data?.totalCost ?? 0;

      setData({
        totalCost,
        totalTokens,
        activeContainers,
        containers: containers.data || [],
        cwMetrics: cw.success ? cw.data : null,
        health: health.checks ?? null,
      });
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="relative">
          <div className="w-12 h-12 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin" />
          <div className="absolute inset-0 bg-primary-500 blur-2xl opacity-20 animate-pulse" />
        </div>
        <p className="text-xs font-black text-gray-500 uppercase tracking-widest animate-pulse">Initializing Terminal...</p>
      </div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-10 max-w-[1600px] mx-auto pb-20"
    >
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-2 border-b border-white/5">
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-white mb-2 leading-none flex items-center gap-3">
            <LayoutIcon className="w-8 h-8 text-primary-500" />
            DASHBOARD
          </h1>
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
            <p className="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em]">System Operational & Secured</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchData}
            disabled={refreshing}
            className={cn(
              "flex items-center gap-2 px-5 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all duration-300",
              "bg-[#161b22] border border-white/5 text-gray-300 hover:text-white hover:border-primary-500/50 shadow-xl",
              refreshing && "opacity-50 cursor-not-allowed"
            )}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin text-primary-500")} />
            {refreshing ? "Refreshing..." : "Sync Engine"}
          </button>
        </div>
      </div>

      {/* Main Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title={t("home.totalCost")}
          value={formatCost(data.totalCost)}
          description="Accumulated Platform Spend"
          trend={{ value: 12.5, isPositive: false }}
        />
        <StatCard
          title={t("home.totalTokens")}
          value={formatNum(data.totalTokens)}
          description="Aggregated Model Interaction"
          trend={{ value: 8.2, isPositive: true }}
        />
        <StatCard
          title={t("home.activeContainers")}
          value={data.activeContainers.toString()}
          description="Live ECS Task Instances"
          trend={{ value: 4.1, isPositive: true }}
        />
        <StatCard
          title="Cluster Health"
          value="99.9%"
          description="High Availability Metric"
          trend={{ value: 0.1, isPositive: true }}
        />
      </div>

      {/* Quick Links Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <motion.div
          whileHover={{ y: -4 }}
          className="lg:col-span-2 bg-[#161b22]/40 backdrop-blur-md rounded-3xl border border-white/5 p-8 shadow-2xl relative overflow-hidden group"
        >
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
            <Zap className="w-32 h-32 text-primary-500" />
          </div>
          <SectionHeader
            title={t("home.costTrend")}
            subtitle="Financial Analytics"
            icon={BarChart3}
            action={
              <Link href="/analytics" className="text-[10px] font-black text-primary-400 hover:text-primary-300 uppercase tracking-widest flex items-center gap-1 group/link">
                Analysis <ArrowUpRight className="w-3 h-3 group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5 transition-transform" />
              </Link>
            }
          />
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Today Cost</p>
              <p className="text-2xl font-black text-white">{formatCost(data.totalCost)}</p>
            </div>
            <div className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Today Tokens</p>
              <p className="text-2xl font-black text-white">{formatNum(data.totalTokens)}</p>
            </div>
          </div>
        </motion.div>

        <motion.div
          whileHover={{ y: -4 }}
          className="bg-[#161b22]/40 backdrop-blur-md rounded-3xl border border-white/5 p-8 shadow-2xl"
        >
          <SectionHeader title={t("home.modelUsage")} subtitle="Compute Distribution" icon={Zap} />
          <div className="space-y-3 mt-4">
            <div className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Active Containers</p>
              <p className="text-2xl font-black text-white">{data.activeContainers}</p>
            </div>
            <div className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Architecture</p>
              <p className="text-sm font-black text-primary-400 uppercase">Direct Bedrock</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Cluster Detail Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Cluster Metrics */}
        <div className="space-y-6">
          <SectionHeader title="Cluster Insights" subtitle="Infrastructure Performance" icon={Cpu} />
          {data.cwMetrics && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-[#161b22]/40 backdrop-blur-md rounded-3xl border border-white/5 p-8 shadow-2xl"
            >
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">CPU</p>
                  <p className="text-xl font-black text-white">{data.cwMetrics.cpuUtilizationPct.toFixed(1)}%</p>
                </div>
                <div className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Memory</p>
                  <p className="text-xl font-black text-white">{data.cwMetrics.memoryUtilizationPct.toFixed(1)}%</p>
                </div>
                <div className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Tasks</p>
                  <p className="text-xl font-black text-white">{data.cwMetrics.taskCount}</p>
                </div>
                <div className="bg-[#0d1117] rounded-xl p-4 border border-white/5">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Instances</p>
                  <p className="text-xl font-black text-white">{data.cwMetrics.containerInstanceCount}</p>
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {/* System Health */}
        <div className="space-y-6">
          <SectionHeader title="System Health" subtitle="Service Matrix" icon={Shield} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[#161b22]/40 backdrop-blur-md rounded-2xl border border-white/5 p-6 flex flex-col gap-4 group hover:border-emerald-500/30 transition-all duration-300">
              <div className="flex items-center justify-between">
                <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                  <Database className="w-4 h-4" />
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-black border border-emerald-500/20">HEALTHY</span>
              </div>
              <div>
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1">DynamoDB Core</p>
                <p className="text-sm font-bold text-white uppercase tracking-tight">Active Connection</p>
              </div>
            </div>

            <div className="bg-[#161b22]/40 backdrop-blur-md rounded-2xl border border-white/5 p-6 flex flex-col gap-4 group hover:border-primary-500/30 transition-all duration-300">
              <div className="flex items-center justify-between">
                <div className="p-2 rounded-lg bg-primary-500/10 text-primary-400">
                  <Layers className="w-4 h-4" />
                </div>
                <span className="px-2 py-0.5 rounded-full bg-primary-500/10 text-primary-400 text-[10px] font-black border border-primary-500/20">V2.4.0</span>
              </div>
              <div>
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1">Stack Architecture</p>
                <p className="text-sm font-bold text-white uppercase tracking-tight">Enterprise Hybrid</p>
              </div>
            </div>
          </div>

          <Link href="/monitoring" className="block group">
            <div className="bg-gradient-to-r from-primary-600 to-blue-600 rounded-2xl p-[1px] shadow-lg shadow-primary-500/20 group-hover:shadow-primary-500/40 transition-all duration-500">
              <div className="bg-[#0d1117] rounded-[15px] p-6 flex items-center justify-between group-hover:bg-transparent transition-colors duration-500">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center group-hover:bg-white/10 transition-colors">
                    <Activity className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-white leading-none mb-1 uppercase italic tracking-tighter">Deep Monitoring</h3>
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-tighter">Access specialized cluster telemetry</p>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center group-hover:translate-x-1 transition-transform">
                  <ChevronRight className="w-5 h-5 text-white" />
                </div>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </motion.div>
  );
}
