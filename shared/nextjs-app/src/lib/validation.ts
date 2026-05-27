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

// ─── Custom Port Routes (ADR-009 extension) ───

export const RESERVED_PATHS = [
  "/api",
  "/_static",
  "/healthz",
  "/stable-",
  "/vscode-remote-resource",
  "/out",
  "/webview",
] as const;

export const RESERVED_PORTS = [8080, 3000, 8000] as const;

export const MAX_CUSTOM_ROUTES = 10; // open tier upper bound; lower tiers enforced in API

const PATH_REGEX = /^\/[a-z0-9][a-z0-9-]*$/;

export const customRouteSchema = z.object({
  path: z
    .string()
    .min(2)
    .max(32)
    .regex(PATH_REGEX, "Path must match /^\\/[a-z0-9][a-z0-9-]*$/")
    .refine(
      (p) => !RESERVED_PATHS.some((rp) => p === rp || p.startsWith(rp)),
      { message: "Path is reserved" },
    ),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .refine((p) => !(RESERVED_PORTS as readonly number[]).includes(p), {
      message: "Port is reserved",
    }),
  label: z.string().min(1).max(32),
});

export const customRoutesPayloadSchema = z.object({
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
    ),
});

export type CustomRouteInput = z.infer<typeof customRouteSchema>;
export type CustomRoutesPayload = z.infer<typeof customRoutesPayloadSchema>;
