import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import AIAssistant from "./ai-assistant";

export default async function AIPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  if (!session.user.isAdmin) redirect("/");

  return <AIAssistant />;
}
