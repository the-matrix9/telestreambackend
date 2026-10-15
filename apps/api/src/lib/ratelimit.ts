import type { Bindings } from "../env";
import { HttpError } from "./errors";

const memory = new Map<string, { windowStart: number; count: number }>();

function tooMany(retryAfter: number): HttpError {
  return new HttpError(429, "rate_limited", "Too many requests. Please slow down.", undefined, {
    "Retry-After": String(Math.max(1, retryAfter)),
  });
}

/**
 * Fixed-window limiter for non-critical traffic (search, stream, token minting).
 * Uses KV when bound (shared across isolates, eventually consistent); otherwise a per-isolate
 * in-memory map, which is a best-effort guard only.
 */
export async function limit(env: Bindings, key: string, max: number, windowSec: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const k = `rl:${key}:${windowStart}`;

  if (env.RATE_KV) {
    const current = Number((await env.RATE_KV.get(k)) ?? 0);
    if (current >= max) throw tooMany(windowStart + windowSec - now);
    await env.RATE_KV.put(k, String(current + 1), { expirationTtl: Math.max(60, windowSec * 2) });
    return;
  }

  const entry = memory.get(key);
  if (!entry || entry.windowStart !== windowStart) {
    if (memory.size > 5000) memory.clear();
    memory.set(key, { windowStart, count: 1 });
    return;
  }
  if (entry.count >= max) throw tooMany(windowStart + windowSec - now);
  entry.count++;
}

/** Strongly-consistent D1 limiter for sensitive endpoints (admin login). */
export async function limitStrict(env: Bindings, key: string, max: number, windowSec: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > max) throw tooMany(windowStart + windowSec - now);
}

export async function resetStrict(env: Bindings, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key).run();
}

export function __resetMemoryLimiterForTests(): void {
  memory.clear();
}
