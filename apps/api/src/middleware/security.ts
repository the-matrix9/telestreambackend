import { safeEqual } from "@telestream/shared";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "../env";
import { forbidden, HttpError, unauthorized } from "../lib/errors";
import { loadSession } from "../lib/session";

export function trustedOrigins(env: Bindings): string[] {
  return env.APP_ORIGIN.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

/** Assigns a request id and the client IP (Cloudflare sets cf-connecting-ip; it cannot be spoofed by clients). */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.set("ip", c.env.CLIENT_IP ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? "local");
  await next();
  c.res.headers.set("x-request-id", c.get("requestId"));
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // The player lives on another origin (Cloudflare Pages), so media bytes must be embeddable cross-origin;
  // they are protected by the signed, expiring token instead. Everything else stays same-site.
  const crossOrigin = c.req.path.startsWith("/api/stream/") || c.env.COOKIE_SAMESITE?.toLowerCase() === "none";
  h.set("Cross-Origin-Resource-Policy", crossOrigin ? "cross-origin" : "same-site");
  if (c.env.ENVIRONMENT === "production") h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  // API responses are JSON/media — nothing should ever execute from them.
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
};

/**
 * Strict CORS: only configured origins get CORS headers; credentialed requests from anywhere else
 * are simply not granted access. Same-origin deployment (the default) needs no CORS at all.
 */
export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  const allowed = origin && trustedOrigins(c.env).includes(origin);
  if (c.req.method === "OPTIONS") {
    if (!allowed) return c.body(null, 204);
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": origin!,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-csrf-token,range",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
  }
  await next();
  if (allowed) {
    c.res.headers.set("Access-Control-Allow-Origin", origin!);
    c.res.headers.set("Access-Control-Allow-Credentials", "true");
    c.res.headers.set("Access-Control-Expose-Headers", "content-range,accept-ranges,content-length,x-request-id");
    c.res.headers.append("Vary", "Origin");
  }
};

/** Reject oversized bodies up-front (Content-Length) and while reading (see readJson). */
export const MAX_JSON_BYTES = 16 * 1024;
export const bodyLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_JSON_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
  await next();
};

export async function readJson(c: { req: { text: () => Promise<string> } }): Promise<unknown> {
  const text = await c.req.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

/** Admin gate: valid server-side session + CSRF (token header and trusted Origin) on unsafe methods. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await loadSession(c);
  if (!session) throw unauthorized();
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (!origin || !trustedOrigins(c.env).includes(origin)) throw forbidden("Untrusted origin");
    const token = c.req.header("x-csrf-token") ?? "";
    if (!safeEqual(token, session.csrf)) throw forbidden("Invalid CSRF token");
  }
  c.set("admin", session);
  await next();
};

/** For unauthenticated state-changing public endpoints (login, setup): enforce trusted Origin. */
export const requireTrustedOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  if (!origin || !trustedOrigins(c.env).includes(origin)) throw forbidden("Untrusted origin");
  await next();
};
