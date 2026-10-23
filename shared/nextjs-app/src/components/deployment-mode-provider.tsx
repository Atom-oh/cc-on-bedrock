"use client";

import { createContext, useContext } from "react";
import type { DeploymentMode } from "@/lib/deployment-mode";

const DeploymentModeContext = createContext<DeploymentMode>("governance");

export function DeploymentModeProvider({
  mode,
  children,
}: {
  mode: DeploymentMode;
  children: React.ReactNode;
}) {
  return <DeploymentModeContext.Provider value={mode}>{children}</DeploymentModeContext.Provider>;
}

export function useDeploymentMode(): DeploymentMode {
  return useContext(DeploymentModeContext);
}
