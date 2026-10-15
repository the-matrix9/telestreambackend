import { z } from "zod";

export const PAGE_LIMIT_DEFAULT = 24;
export const PAGE_LIMIT_MAX = 60;

const intFromQuery = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

/** Public video ids are 96 random bits, hex encoded. Anything else is rejected before touching the database. */
export const PUBLIC_ID_RE = /^[0-9a-f]{24}$/;

export const sortSchema = z.enum(["newest", "oldest", "relevance"]);
export type VideoSort = z.infer<typeof sortSchema>;

export const videoListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  sort: sortSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: intFromQuery(1, PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  /** minimum / maximum duration in seconds */
  minDuration: intFromQuery(0, 86_400 * 2).optional(),
  maxDuration: intFromQuery(0, 86_400 * 2).optional(),
  /** only videos published within the last N days */
  days: intFromQuery(1, 3650).optional(),
  channel: intFromQuery(1, 2_147_483_647).optional(),
});
export type VideoListQuery = z.infer<typeof videoListQuerySchema>;

export const adminLoginSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(1).max(256),
});

export const adminSetupSchema = z.object({
  setupToken: z.string().min(8).max(256),
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, "Letters, digits, . _ - only"),
  password: z.string().min(12, "Use at least 12 characters").max(256),
});

export const requestCodeSchema = z.object({
  phone: z.string().trim().regex(/^\+?[0-9]{7,15}$/, "Use international format, e.g. +14155550123"),
});
export const verifyCodeSchema = z.object({
  code: z.string().trim().regex(/^[0-9]{3,8}$/, "Enter the numeric login code"),
});
export const verifyPasswordSchema = z.object({
  password: z.string().min(1).max(256),
});

export const channelCreateSchema = z.object({
  /** numeric id (-100…), plain numeric id, or @username */
  channel: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^(-?[0-9]{5,20}|@?[A-Za-z][A-Za-z0-9_]{3,31})$/, "Enter a channel ID such as -1001234567890 or @username"),
});

export const syncStartSchema = z.object({
  /** must be explicitly true — importing channel content requires confirmation */
  confirm: z.literal(true),
  mode: z.enum(["initial", "incremental", "resync", "verify"]).default("initial"),
});

export const watchHistorySchema = z.object({
  visitorId: z.string().uuid(),
  videoId: z.number().int().positive(),
  positionSeconds: z.number().min(0).max(86_400 * 2),
});

export const visitorQuerySchema = z.object({
  visitorId: z.string().uuid(),
});

export const adminVideoQuerySchema = videoListQuerySchema.extend({
  status: z.enum(["available", "unavailable", "deleted", "unsupported"]).optional(),
});

export const jobListQuerySchema = z.object({
  limit: intFromQuery(1, 100).default(25),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
});

export const auditQuerySchema = z.object({
  limit: intFromQuery(1, 200).default(50),
});
