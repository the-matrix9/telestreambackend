import { sha256Hex, toBase64Url } from "@telestream/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AdminContext, AppEnv, Bindings } from "../env";

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function isSecureOrigin(env: Bindings): boolean {
  return env.APP_ORIGIN.split(",")[0]!.trim().startsWith("https://");
}

/** Strict by default. "none" is needed only when the frontend lives on a different *site* than the API (requires HTTPS). */
function env_sameSite(env: Bindings): "Strict" | "None" {
  return env.COOKIE_SAMESITE?.toLowerCase() === "none" && isSecureOrigin(env) ? "None" : "Strict";
}

export function cookieName(env: Bindings): string {
  return isSecureOrigin(env) ? "__Host-ts_admin" : "ts_admin";
}

function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function createSession(c: Context<AppEnv>, userId: number): Promise<{ csrf: string }> {
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await c.env.DB.prepare(
    "INSERT INTO admin_sessions (user_id, token_hash, csrf_token, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(userId, await sha256Hex(token), csrf, expires, c.get("ip"), (c.req.header("user-agent") ?? "").slice(0, 200))
    .run();
  setCookie(c, cookieName(c.env), token, {
    httpOnly: true,
    secure: isSecureOrigin(c.env),
    sameSite: env_sameSite(c.env),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  // opportunistic cleanup of expired sessions
  c.executionCtx?.waitUntil?.(
    c.env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < unixepoch()").run().then(() => undefined),
  );
  return { csrf };
}

export async function loadSession(c: Context<AppEnv>): Promise<AdminContext | null> {
  const token = getCookie(c, cookieName(c.env));
  if (!token || token.length > 200) return null;
  const row = await c.env.DB.prepare(
    `SELECT s.id AS session_id, s.csrf_token, u.id AS user_id, u.username
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > unixepoch()`,
  )
    .bind(await sha256Hex(token))
    .first<{ session_id: number; csrf_token: string; user_id: number; username: string }>();
  if (!row) return null;
  return { userId: row.user_id, username: row.username, csrf: row.csrf_token, sessionId: row.session_id };
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, cookieName(c.env));
  if (token) {
    await c.env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, cookieName(c.env), { path: "/", secure: isSecureOrigin(c.env) });
}

export async function destroyAllSessionsForUser(env: Bindings, userId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE user_id = ?").bind(userId).run();
}
