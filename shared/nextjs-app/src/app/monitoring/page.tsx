import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import MonitoringDashboard from "./monitoring-dashboard";

export default async function MonitoringPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  if (!session.user.isAdmin) redirect("/analytics");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          Operations Monitoring
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Proxy health, ECS status, active sessions, and error rates
        </p>
      </div>
      <MonitoringDashboard
        domainName={process.env.DOMAIN_NAME ?? "example.com"}
        devSubdomain={process.env.DEV_SUBDOMAIN ?? "dev"}
      />
    </div>
  );
}
