"use client";

import { SessionProvider } from "next-auth/react";
import { I18nProvider } from "@/lib/i18n";
import { DeploymentModeProvider } from "@/components/deployment-mode-provider";
import type { DeploymentMode } from "@/lib/deployment-mode";

export default function Providers({
  children,
  deploymentMode,
}: {
  children: React.ReactNode;
  deploymentMode: DeploymentMode;
}) {
  return (
    <SessionProvider>
      <DeploymentModeProvider mode={deploymentMode}>
        <I18nProvider>{children}</I18nProvider>
      </DeploymentModeProvider>
    </SessionProvider>
  );
}
