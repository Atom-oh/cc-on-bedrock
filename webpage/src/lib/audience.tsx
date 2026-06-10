"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

export type Audience = "user" | "operator" | "all";

const STORAGE_KEY = "cc-on-bedrock-audience";

interface AudienceContextValue {
  audience: Audience;
  setAudience: (a: Audience) => void;
  /** Returns true if a page tagged with `pageAudiences` should be visible. */
  shows: (pageAudiences: readonly Audience[]) => boolean;
}

const AudienceContext = createContext<AudienceContextValue | null>(null);

export function AudienceProvider({ children }: { children: ReactNode }) {
  const [audience, setAudienceState] = useState<Audience>("user");

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (saved === "user" || saved === "operator" || saved === "all") setAudienceState(saved);
  }, []);

  const setAudience = (a: Audience) => {
    setAudienceState(a);
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, a);
  };

  const shows = (pageAudiences: readonly Audience[]) => {
    if (audience === "all") return true;
    return pageAudiences.includes("all") || pageAudiences.includes(audience);
  };

  return (
    <AudienceContext.Provider value={{ audience, setAudience, shows }}>
      {children}
    </AudienceContext.Provider>
  );
}

export function useAudience() {
  const ctx = useContext(AudienceContext);
  if (!ctx) throw new Error("useAudience must be used within AudienceProvider");
  return ctx;
}
