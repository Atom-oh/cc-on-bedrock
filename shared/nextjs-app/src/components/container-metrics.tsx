'use client';

import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface MetricProps {
  cpu: number;
  cpuLimit: number;
  memory: number;
  memoryLimit: number;
  networkRx: number;
  networkTx: number;
  diskRead: number;
  diskWrite: number;
}

interface TimeseriesData {
  time: string;
  cpu: number;
  memory: number;
  networkRx: number;
  networkTx: number;
}

interface ContainerMetricsProps {
  metrics: MetricProps;
  timeseries: TimeseriesData[];
  loading?: boolean;
}

const formatBytes = (bytes: number, decimals = 2) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const CircularGauge = ({
  value,
  max,
  label,
  subLabel,
  id,
}: {
  value: number;
  max: number;
  label: string;
  subLabel: string;
  id: string;
}) => {
  const percentage = max > 0 ? Math.min(Math.max((value / max) * 100, 0), 100) : 0;
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className="relative flex flex-col items-center justify-center h-full w-full">
      <svg className="w-32 h-32 transform -rotate-90">
        <defs>
          <linearGradient id={`gradient-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#10b981" />
            <stop offset="60%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#ef4444" />
          </linearGradient>
        </defs>
        <circle
          cx="64" cy="64" r={radius}
          stroke="currentColor" strokeWidth="8" fill="transparent"
          className="text-gray-800"
        />
        <circle
          cx="64" cy="64" r={radius}
          stroke={`url(#gradient-${id})`}
          strokeWidth="8" strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" fill="transparent"
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-gray-100">{Math.round(percentage)}%</span>
        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">{subLabel}</span>
      </div>
      <div className="mt-2 text-center">
        <p className="text-sm font-semibold text-gray-300">{label}</p>
      </div>
    </div>
  );
};

const MetricCard = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <div className={`bg-[#161b22]/40 backdrop-blur-md border border-gray-800/60 p-5 rounded-2xl shadow-xl transition-all duration-300 hover:border-gray-700 hover:bg-[#161b22]/60 ${className}`}>
    {children}
  </div>
);

const ChartCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="bg-[#0d1117] border border-gray-800/40 rounded-2xl p-6 flex flex-col h-[280px]">
    <h3 className="text-gray-400 text-xs font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
      <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
      {title}
    </h3>
    <div className="flex-1 w-full">{children}</div>
  </div>
);

const customTooltipStyle = {
  contentStyle: {
    backgroundColor: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '12px',
    fontSize: '12px',
    color: '#c9d1d9',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.4)',
  },
  itemStyle: { padding: '2px 0' },
};

export default function ContainerMetrics({ metrics, timeseries, loading }: ContainerMetricsProps) {
  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-[#161b22]/40 border border-gray-800/60 rounded-2xl h-48" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-100 tracking-tight">
            Container Resources
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">Real-time container metrics</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-900/50 rounded-full border border-gray-800">
          <div className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </div>
          <span className="text-[10px] font-bold text-emerald-500/80 uppercase tracking-tighter">Live</span>
        </div>
      </div>

      {/* 2x2 Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <MetricCard>
          <CircularGauge value={metrics.cpu} max={metrics.cpuLimit} label="CPU" subLabel="Utilization" id="cpu" />
        </MetricCard>

        <MetricCard>
          <CircularGauge
            value={metrics.memory} max={metrics.memoryLimit}
            label="Memory"
            subLabel={`${Math.round(metrics.memory)} / ${Math.round(metrics.memoryLimit)} MB`}
            id="memory"
          />
        </MetricCard>

        <MetricCard className="flex flex-col justify-between">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-blue-500/10 rounded-lg">
              <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </div>
            <span className="text-sm font-bold text-gray-300">Network I/O</span>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1 bg-emerald-500/20 rounded"><svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg></div>
                <span className="text-xs text-gray-400">Rx</span>
              </div>
              <span className="text-lg font-mono font-bold text-gray-100 transition-all duration-500">{formatBytes(metrics.networkRx)}/s</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1 bg-blue-500/20 rounded"><svg className="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg></div>
                <span className="text-xs text-gray-400">Tx</span>
              </div>
              <span className="text-lg font-mono font-bold text-gray-100 transition-all duration-500">{formatBytes(metrics.networkTx)}/s</span>
            </div>
          </div>
        </MetricCard>

        <MetricCard className="flex flex-col justify-between">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-purple-500/10 rounded-lg">
              <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h8" /></svg>
            </div>
            <span className="text-sm font-bold text-gray-300">Disk I/O</span>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Read</span>
              <span className="text-lg font-mono font-bold text-gray-100 transition-all duration-500">{formatBytes(metrics.diskRead)}/s</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Write</span>
              <span className="text-lg font-mono font-bold text-gray-100 transition-all duration-500">{formatBytes(metrics.diskWrite)}/s</span>
            </div>
          </div>
        </MetricCard>
      </div>

      {/* Area Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ChartCard title="CPU & Memory">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timeseries}>
              <defs>
                <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorMem" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#30363d" />
              <XAxis dataKey="time" hide />
              <YAxis hide />
              <Tooltip {...customTooltipStyle} />
              <Area type="monotone" dataKey="cpu" name="CPU" stroke="#3b82f6" fillOpacity={1} fill="url(#colorCpu)" strokeWidth={2} />
              <Area type="monotone" dataKey="memory" name="Memory" stroke="#8b5cf6" fillOpacity={1} fill="url(#colorMem)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Network Rx / Tx">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timeseries}>
              <defs>
                <linearGradient id="colorRx" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorTx" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#30363d" />
              <XAxis dataKey="time" hide />
              <YAxis hide />
              <Tooltip {...customTooltipStyle} />
              <Area type="monotone" dataKey="networkRx" name="Rx" stroke="#10b981" fillOpacity={1} fill="url(#colorRx)" strokeWidth={2} />
              <Area type="monotone" dataKey="networkTx" name="Tx" stroke="#f59e0b" fillOpacity={1} fill="url(#colorTx)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
