import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import DeptDashboard from "./dept-dashboard";

export default async function DeptPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  // Check if user is dept-manager or admin
  const groups = session.user.groups ?? [];
  const isDeptManager = groups.includes("dept-manager") || groups.includes("admin");

  if (!isDeptManager) {
    redirect("/user");
  }

  const isAdmin = groups.includes("admin");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">Department Dashboard</h1>
        <p className="mt-1 text-sm text-gray-400">
          Manage your department members, budget, and approval requests
        </p>
      </div>
      <DeptDashboard user={session.user} isAdmin={isAdmin} />
    </div>
  );
}
