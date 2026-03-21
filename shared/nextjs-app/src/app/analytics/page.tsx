import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import AnalyticsDashboard from "./analytics-dashboard";

export default async function AnalyticsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  return (
    <div>
      <AnalyticsDashboard isAdmin={session.user.isAdmin} />
    </div>
  );
}
