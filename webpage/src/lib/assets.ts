/**
 * Resolves a public-asset path to a full URL that respects Next.js basePath.
 *
 * Why this exists:
 *   `next/image` with `unoptimized: true` (required for `output: 'export'`)
 *   does NOT auto-prepend the configured `basePath` to the rendered `src`
 *   attribute. So `<Image src="/img/foo.png" />` ships as
 *   `<img src="/img/foo.png">` instead of `<img src="/cc-on-bedrock/img/foo.png">`,
 *   producing 404s when the site is deployed under a subpath.
 *
 *   We use plain `<img>` tags together with this helper for static
 *   screenshots/diagrams instead.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "/cc-on-bedrock";

export function asset(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${normalized}`;
}
