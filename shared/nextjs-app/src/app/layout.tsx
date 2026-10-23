import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import "./globals.css";
import Providers from "./providers";
import AppShell from "@/components/app-shell";
import { getDeploymentMode } from "@/lib/deployment-mode";

export const metadata: Metadata = {
  title: "CC-on-Bedrock Dashboard",
  description:
    "Multi-user Claude Code development environment on AWS Bedrock",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // DEPLOYMENT_MODE is a runtime env, so the layout must not be prerendered at build time.
  noStore();
  return (
    <html lang="en" className="dark">
      <body className="font-sans bg-[#0a0f1a]">
        <Providers deploymentMode={getDeploymentMode()}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
