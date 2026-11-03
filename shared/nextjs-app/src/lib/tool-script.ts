import fs from "fs";
import path from "path";

// Reads a Local CLI script from the repo's tools/ directory. The dashboard image
// copies them to public/tools/ (docker/dashboard/Dockerfile); dev and tests read
// the repo copy. Cached per file for the life of the process.
const cache = new Map<string, string>();

export function loadToolScript(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const candidates = [
    path.join(process.cwd(), "public", "tools", name),
    path.join(process.cwd(), "tools", name),
    path.join(process.cwd(), "..", "..", "tools", name),
    path.resolve(__dirname, "../../../../../../tools", name),
    path.resolve(__dirname, "../../../../../../../tools", name),
  ];
  for (const p of candidates) {
    try {
      const s = fs.readFileSync(p, "utf8");
      cache.set(name, s);
      return s;
    } catch {
      /* try next */
    }
  }
  throw new Error(`${name} not found in: ${candidates.join(", ")}`);
}
