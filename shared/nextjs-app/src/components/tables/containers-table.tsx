"use client";

import type { ContainerInfo } from "@/lib/types";

interface ContainersTableProps {
  containers: ContainerInfo[];
  onStop?: (taskArn: string) => void;
  domainName?: string;
  devSubdomain?: string;
}

const statusColors: Record<string, string> = {
  RUNNING: "bg-green-900/40 text-green-400",
  PENDING: "bg-yellow-900/40 text-yellow-400",
  PROVISIONING: "bg-yellow-900/40 text-yellow-400",
  STOPPED: "bg-gray-800 text-gray-500",
  DEPROVISIONING: "bg-orange-900/40 text-orange-400",
  STOPPING: "bg-orange-900/40 text-orange-400",
};

export default function ContainersTable({
  containers,
  onStop,
  domainName = "example.com",
  devSubdomain = "dev",
}: ContainersTableProps) {
  return (
    <div className="bg-[#161b22] rounded-xl border border-gray-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800 bg-[#0d1117]">
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                User / Subdomain
              </th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                Config
              </th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                Resources
              </th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                Started
              </th>
              <th className="px-5 py-3 text-left text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                URL
              </th>
              <th className="px-5 py-3 text-right text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {containers.map((container) => {
              const url = `https://${container.subdomain}.${devSubdomain}.${domainName}`;
              return (
                <tr key={container.taskArn} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <p className="text-sm font-medium text-gray-200">
                      {container.username || "Unknown"}
                    </p>
                    <p className="text-[10px] text-gray-500">
                      {container.subdomain || container.taskId}
                    </p>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded-full ${
                      statusColors[container.status] ?? "bg-gray-800 text-gray-500"
                    }`}>
                      {container.status === "RUNNING" && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      )}
                      {container.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <div className="flex gap-1">
                      <span className="px-1.5 py-0.5 text-[10px] bg-gray-800 text-gray-400 rounded">
                        {container.containerOs === "al2023" ? "AL2023" : "Ubuntu"}
                      </span>
                      <span className="px-1.5 py-0.5 text-[10px] bg-gray-800 text-gray-400 rounded">
                        {container.resourceTier}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-xs text-gray-500">
                    {container.cpu} vCPU / {container.memory} MiB
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-xs text-gray-500">
                    {container.startedAt
                      ? new Date(container.startedAt).toLocaleString()
                      : "-"}
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    {container.status === "RUNNING" && container.subdomain ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        {url}
                      </a>
                    ) : (
                      <span className="text-xs text-gray-600">-</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-right">
                    {onStop &&
                      (container.status === "RUNNING" ||
                        container.status === "PENDING") && (
                        <button
                          onClick={() => onStop(container.taskArn)}
                          className="px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30 rounded-lg transition-colors"
                        >
                          Stop
                        </button>
                      )}
                  </td>
                </tr>
              );
            })}
            {containers.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-6 py-12 text-center text-sm text-gray-600"
                >
                  No containers running.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
