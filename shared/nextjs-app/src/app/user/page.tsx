import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import UserPortal from "./user-portal";

export default async function UserPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">My Environment</h1>
        <p className="mt-1 text-sm text-gray-400">
          Your container status, usage, and workspace info
        </p>
      </div>
      <UserPortal user={session.user} />
    </div>
  );
}
