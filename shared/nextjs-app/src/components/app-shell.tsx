"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./sidebar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-[#0a0f1a]">
        <div className="p-6 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
