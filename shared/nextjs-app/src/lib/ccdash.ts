export interface CcdashLinks {
  home: string;
  collector: string;
}

// Optional ccdash integration: the base URL comes from Terraform `ccdash_url` (CCDASH_URL env).
// Anything empty or not https disables the integration (returns null).
export function ccdashLinks(baseUrl: string | undefined): CcdashLinks | null {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+/.test(base)) return null;
  return { home: base, collector: `${base}/collector` };
}
