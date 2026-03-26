import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import BudgetManagement from "./budget-management";

export default async function BudgetsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  if (!session.user.isAdmin) redirect("/analytics");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">Budget Settings</h1>
        <p className="mt-1 text-sm text-gray-400">
          Manage department and user budget limits
        </p>
      </div>
      <BudgetManagement />
    </div>
  );
}
