import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import TokenDashboard from "./token-dashboard";

export default async function TokensPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  if (!session.user.isAdmin) redirect("/analytics");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">Token Usage</h1>
        <p className="mt-1 text-sm text-gray-400">
          Platform-wide token usage by department and user
        </p>
      </div>
      <TokenDashboard />
    </div>
  );
}
