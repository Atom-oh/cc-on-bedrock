import { z } from "zod";

const subdomain = z.string().min(3).max(30).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Invalid subdomain format");

export const startContainerSchema = z.object({
  username: z.string().email(),
  subdomain,
  department: z.string().min(1).max(50),
  containerOs: z.enum(["ubuntu", "al2023"]),
  resourceTier: z.enum(["light", "standard", "power"]),
  securityPolicy: z.enum(["open", "restricted", "locked"]),
});

export const stopContainerSchema = z.object({
  subdomain,
  reason: z.string().max(200).optional(),
});

export const keepAliveSchema = z.object({
  userId: z.string().email().optional(),
});

export const createUserSchema = z.object({
  email: z.string().email("Invalid email"),
  subdomain,
  department: z.string().min(1).max(50).default("default"),
  containerOs: z.enum(["ubuntu", "al2023"]),
  resourceTier: z.enum(["light", "standard", "power"]),
  securityPolicy: z.enum(["open", "restricted", "locked"]),
});

export const updateUserSchema = z.object({
  username: z.string().min(1),
  containerOs: z.enum(["ubuntu", "al2023"]).optional(),
  resourceTier: z.enum(["light", "standard", "power"]).optional(),
  securityPolicy: z.enum(["open", "restricted", "locked"]).optional(),
});

// ─── Custom Port Routes (ADR-009 extension, ADR-027) ───

// code-server 내부경로 + nginx 인프라 경로 (등록 불가). /api 는 제거(seedable).
export const RESERVED_PATHS = [
  "/_static",
  "/healthz",
  "/stable-",
  "/vscode-remote-resource",
  "/out",
  "/webview",
  "/manifest.json",
  "/health",
  "/nginx-status",
] as const;

export const RESERVED_PORTS = [8080] as const; // code-server only

export const MAX_CUSTOM_ROUTES = 5;

// "/" (루트) 또는 multi-segment. 각 세그먼트 [a-z0-9][a-z0-9-]*, 끝슬래시·연속슬래시 없음.
const SUBPATH_REGEX = /^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

/** 세그먼트 경계 기준 예약 판정. `/apiary` 가 `/api` 로 오판되지 않음. */
export function isReservedPath(path: string): boolean {
  return RESERVED_PATHS.some(
    (rp) => path === rp || path.startsWith(rp + "/") || (rp.endsWith("-") && path.startsWith(rp)),
  );
}

export const customRouteSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(64)
    .refine((p) => p === "/" || SUBPATH_REGEX.test(p), {
      message: "Path must be '/' or like /preview or /api/v1 (lowercase, no trailing slash)",
    })
    .refine((p) => !isReservedPath(p), { message: "Path is reserved" }),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .refine((p) => p !== 8080, {
      message: "8080은 code-server가 사용 중인 포트입니다 (노출 불가)",
    }),
  label: z.string().min(1).max(32),
});

export const customRoutesPayloadSchema = z.object({
  // M3: client echoes the version it loaded → server uses it as the CAS expectedVersion
  // (true optimistic lock; stale-client edits get a 409 instead of silently overwriting).
  version: z.number().int().nonnegative().optional(),
  routes: z
    .array(customRouteSchema)
    .max(MAX_CUSTOM_ROUTES)
    .refine(
      (routes) => new Set(routes.map((r) => r.path)).size === routes.length,
      { message: "Duplicate paths are not allowed" },
    )
    .refine(
      (routes) => new Set(routes.map((r) => r.port)).size === routes.length,
      { message: "Duplicate ports are not allowed" },
    )
    .refine((routes) => routes.filter((r) => r.path === "/").length <= 1, {
      message: "Only one route may use the root path '/'",
    }),
});

export type CustomRouteInput = z.infer<typeof customRouteSchema>;
export type CustomRoutesPayload = z.infer<typeof customRoutesPayloadSchema>;
