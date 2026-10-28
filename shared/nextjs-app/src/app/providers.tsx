"use client";

import { SessionProvider } from "next-auth/react";
import { I18nProvider } from "@/lib/i18n";
import { DeploymentModeProvider } from "@/components/deployment-mode-provider";
import { CcdashProvider } from "@/components/ccdash-provider";
import type { CcdashLinks } from "@/lib/ccdash";
import type { DeploymentMode } from "@/lib/deployment-mode";

export default function Providers({
  children,
  deploymentMode,
  ccdashLinks,
}: {
  children: React.ReactNode;
  deploymentMode: DeploymentMode;
  ccdashLinks: CcdashLinks | null;
}) {
  return (
    <SessionProvider>
      <DeploymentModeProvider mode={deploymentMode}>
        <CcdashProvider links={ccdashLinks}>
          <I18nProvider>{children}</I18nProvider>
        </CcdashProvider>
      </DeploymentModeProvider>
    </SessionProvider>
  );
}
