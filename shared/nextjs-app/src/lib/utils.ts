import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Derive a deterministic subdomain from an email address.
 * Convention: local part, dots replaced with hyphens, lowercased.
 * e.g. "atom.oh@example.com" → "atom-oh"
 */
export function emailToSubdomain(email: string): string {
  return email.split("@")[0].replace(/\./g, "-").toLowerCase();
}

/**
 * Canonical Local-role subdomain from an email (mirror of lambda/role_factory.py
 * `derive_subdomain`, ADR-031): local part lowercased, non-[a-z0-9-] runs become one
 * hyphen, trimmed, cut to 30 chars. Returns null when fewer than 3 chars remain.
 */
export function deriveSubdomain(email: string): string | null {
  const local = (email || "").split("@")[0].toLowerCase();
  const cleaned = local.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const truncated = cleaned.slice(0, 30).replace(/-+$/, "");
  return truncated.length >= 3 ? truncated : null;
}
