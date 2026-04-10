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
