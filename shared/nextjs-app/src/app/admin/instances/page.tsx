import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getDeploymentMode } from "@/lib/deployment-mode";
import ContainerManagement from "./container-management";

export default async function ContainersPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  if (!session.user.isAdmin) redirect("/analytics");
  // Instance management is DevEnv-only (hidden from the sidebar in governance mode).
  if (getDeploymentMode() !== "devenv") redirect("/admin");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">
          Instance Management
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Start, stop, and manage dev environment instances
        </p>
      </div>
      <ContainerManagement
        domainName={process.env.DOMAIN_NAME ?? "atomai.click"}
        devSubdomain={process.env.DEV_SUBDOMAIN ?? "dev"}
      />
    </div>
  );
}
