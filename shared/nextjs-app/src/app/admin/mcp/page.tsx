import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import McpManagement from "./mcp-management";

export default async function McpPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  if (!session.user.isAdmin) redirect("/analytics");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">MCP Gateway Management</h1>
        <p className="mt-1 text-sm text-gray-400">
          Manage MCP tool catalog and department gateway assignments
        </p>
      </div>
      <McpManagement />
    </div>
  );
}
