"use client";

import { createContext, useContext } from "react";
import type { CcdashLinks } from "@/lib/ccdash";

// Links are computed on the server from CCDASH_URL and handed down as props, so the env
// value never reaches the client bundle (no NEXT_PUBLIC_*). null = integration disabled.
const CcdashContext = createContext<CcdashLinks | null>(null);

export function CcdashProvider({
  links,
  children,
}: {
  links: CcdashLinks | null;
  children: React.ReactNode;
}) {
  return <CcdashContext.Provider value={links}>{children}</CcdashContext.Provider>;
}

export function useCcdashLinks(): CcdashLinks | null {
  return useContext(CcdashContext);
}
