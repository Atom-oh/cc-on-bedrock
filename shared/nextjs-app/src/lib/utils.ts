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
