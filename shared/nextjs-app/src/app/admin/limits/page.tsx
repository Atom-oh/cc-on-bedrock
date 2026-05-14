import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import LimitManagement from "./limit-management";

export default async function AdminLimitsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  if (!session.user.isAdmin) redirect("/analytics");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">Normalized Token Limits</h1>
        <p className="mt-1 text-sm text-gray-400">
          Per-user and per-department normalized token limits for Local Governance Mode (ADR-014).
          When usage reaches the limit, a Deny policy is attached to the user&apos;s IAM role
          until the next period reset.
        </p>
      </div>
      <LimitManagement />
    </div>
  );
}
