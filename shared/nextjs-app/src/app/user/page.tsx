import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import UserPortal from "./user-portal";
import { getDeploymentMode } from "@/lib/deployment-mode";

export default async function UserPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  const devenv = getDeploymentMode() === "devenv";

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">{devenv ? "My Environment" : "Local Setup"}</h1>
        <p className="mt-1 text-sm text-gray-400">
          {devenv
            ? "Your instance status, usage, and workspace info"
            : "Install the CLI, sign in with Cognito, and run Claude Code or Codex on your PC"}
        </p>
      </div>
      <UserPortal
        user={session.user}
        runtimeConfig={{
          domainName: process.env.DOMAIN_NAME ?? "",
          devSubdomain: process.env.DEV_SUBDOMAIN ?? "",
        }}
      />
    </div>
  );
}
