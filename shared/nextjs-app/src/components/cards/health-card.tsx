import type { HealthStatus } from "@/lib/types";

const statusConfig = {
  healthy: {
    bg: "bg-green-900/30",
    text: "text-green-400",
    dot: "bg-green-400",
    label: "Healthy",
  },
  degraded: {
    bg: "bg-yellow-900/30",
    text: "text-yellow-400",
    dot: "bg-yellow-400",
    label: "Degraded",
  },
  unhealthy: {
    bg: "bg-red-900/30",
    text: "text-red-400",
    dot: "bg-red-400",
    label: "Unhealthy",
  },
};

export default function HealthCard({
  service,
  status,
  message,
  lastChecked,
}: HealthStatus) {
  const config = statusConfig[status];

  return (
    <div className="bg-[#161b22] rounded-xl border border-gray-800 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-200">{service}</h3>
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${config.bg} ${config.text}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${config.dot} animate-pulse`} />
          {config.label}
        </span>
      </div>
      {message && <p className="mt-2 text-sm text-gray-400">{message}</p>}
      <p className="mt-3 text-[10px] text-gray-600">
        Last checked: {new Date(lastChecked).toLocaleTimeString()}
      </p>
    </div>
  );
}
