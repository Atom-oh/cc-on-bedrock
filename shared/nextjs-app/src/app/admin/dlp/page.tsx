import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import DlpManagement from "./dlp-management";

export default async function DlpPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) redirect("/");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">DLP Firewall Management</h1>
        <p className="text-sm text-gray-500 mt-1">Manage DNS Firewall domain allow/deny lists for DLP tiers</p>
      </div>
      <DlpManagement />
    </div>
  );
}
