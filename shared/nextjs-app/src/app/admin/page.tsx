import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import UserManagement from "./user-management";

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  if (!session.user.isAdmin) redirect("/analytics");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">User Management</h1>
        <p className="mt-1 text-sm text-gray-400">
          Create, update, and manage Cognito users and LiteLLM API keys
        </p>
      </div>
      <UserManagement />
    </div>
  );
}
