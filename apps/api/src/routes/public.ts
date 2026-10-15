import { PUBLIC_ID_RE, signPlaybackToken, verifyPlaybackToken, type PlayInfoDTO } from "@telestream/shared";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { HttpError, notFound } from "../lib/errors";
import { log } from "../lib/log";
import { limit } from "../lib/ratelimit";
import { TelegramService } from "../lib/telegram";
import { getPlayTarget } from "../lib/videos";
import { trustedOrigins } from "../middleware/security";

/**
 * The public surface is deliberately tiny. A visitor can learn exactly two things:
 *   GET /api/play/:publicId    -> { streamUrl, expiresAt, durationSeconds }
 *   GET /api/stream/:publicId  -> the video bytes (needs the signed, expiring token from /play)
 * No titles, descriptions, thumbnails, listings, search or sequential ids are exposed.
 */

/** A stream link lives for twice the video's length (never less than this floor). */
export const PLAYBACK_TTL_FACTOR = 2;
export const MIN_PLAYBACK_TTL_SECONDS = 120;
/** Fallback when Telegram did not report a duration. */
export const UNKNOWN_DURATION_TTL_SECONDS = 4 * 60 * 60;
export const MAX_STREAMS_PER_IP = 6;

export function playbackTtlSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return UNKNOWN_DURATION_TTL_SECONDS;
  return Math.max(MIN_PLAYBACK_TTL_SECONDS, Math.ceil(durationSeconds * PLAYBACK_TTL_FACTOR));
}

const activeStreams = new Map<string, number>();
export function __activeStreamsForTests() { return activeStreams; }

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, time: Math.floor(Date.now() / 1000) }, 200, { "Cache-Control": "no-store" });
  } catch {
    return c.json({ ok: false }, 503, { "Cache-Control": "no-store" });
  }
});

publicRoutes.get("/play/:publicId", async (c) => {
  await limit(c.env, `play:${c.get("ip")}`, 60, 60);
  const publicId = c.req.param("publicId");
  if (!PUBLIC_ID_RE.test(publicId)) throw notFound("Video not found");
  const row = await getPlayTarget(c.env, publicId);
  if (!row || row.availability_status !== "available") throw notFound("Video not found");

  const now = Math.floor(Date.now() / 1000);
  const exp = now + playbackTtlSeconds(row.duration_seconds);
  const token = await signPlaybackToken(c.env.PLAYBACK_SECRET, { vid: row.id, exp });
  const base = (c.env.API_PUBLIC_URL ?? "").replace(/\/+$/, "");

  const body: PlayInfoDTO = {
    streamUrl: `${base}/api/stream/${publicId}?t=${token}`,
    expiresAt: exp,
    durationSeconds: row.duration_seconds,
  };
  c.header("Cache-Control", "private, no-store"); // contains a playback token
  return c.json(body);
});

/** Decrements the per-IP counter exactly once, whether the body finishes, errors or the client disconnects. */
function trackStream(body: ReadableStream<Uint8Array>, ip: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (activeStreams.get(ip) ?? 1) - 1;
    if (n <= 0) activeStreams.delete(ip);
    else activeStreams.set(ip, n);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { release(); controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * Cheap browser-level guards against the stream link being opened or hot-linked as a file.
 * They stop casual "paste the link in a tab and Save As" and other sites embedding the stream; they cannot stop a
 * determined person with a download tool while the link is still valid (see docs/LIMITATIONS.md).
 */
function assertPlayerRequest(c: import("hono").Context<AppEnv>): void {
  const dest = c.req.header("sec-fetch-dest");
  if (dest === "document" || dest === "iframe" || dest === "embed" || dest === "object") {
    throw new HttpError(403, "playback_only", "This link only works inside the player.");
  }
  const referer = c.req.header("referer");
  if (referer) {
    let origin = "";
    try { origin = new URL(referer).origin; } catch { /* malformed referer is treated as foreign */ }
    if (!trustedOrigins(c.env).includes(origin)) throw new HttpError(403, "playback_only", "This link only works inside the player.");
  }
}

async function handleStream(c: import("hono").Context<AppEnv>): Promise<Response> {
  const ip = c.get("ip");
  const publicId = c.req.param("publicId") ?? "";
  const invalid = () => new HttpError(403, "invalid_playback_token", "Playback link is missing or expired. Reload the page to continue.");
  if (!PUBLIC_ID_RE.test(publicId)) throw invalid();

  // 1. Authorisation: short-lived signed token bound to this video. Unknown ids look exactly like bad tokens.
  const target = await getPlayTarget(c.env, publicId);
  const token = c.req.query("t") ?? "";
  const claims = token ? await verifyPlaybackToken(c.env.PLAYBACK_SECRET, token) : null;
  if (!target || !claims || claims.vid !== target.id) throw invalid();
  assertPlayerRequest(c);

  // 2. Abuse controls: request rate and concurrent streams per client.
  await limit(c.env, `stream:${ip}`, 900, 60);
  if ((activeStreams.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) {
    throw new HttpError(429, "too_many_streams", "Too many simultaneous streams from your connection.", undefined, { "Retry-After": "5" });
  }

  if (target.availability_status !== "available") {
    throw new HttpError(404, "video_unavailable", "This video is no longer available.");
  }

  const method = c.req.method === "HEAD" ? "HEAD" : "GET";
  const tg = new TelegramService(c.env);
  let upstream: Response;
  try {
    upstream = await tg.stream(target.telegram_channel_id, target.telegram_message_id, method, c.req.header("range") ?? null, c.req.raw.signal);
  } catch (err) {
    if (err instanceof HttpError && err.code === "media_unavailable") {
      c.executionCtx.waitUntil(
        c.env.DB.prepare("UPDATE videos SET availability_status = 'unavailable' WHERE id = ?").bind(target.id).run().then(() => undefined),
      );
      throw new HttpError(404, "video_unavailable", "This video can no longer be streamed from Telegram.");
    }
    throw err;
  }

  const headers = new Headers({
    // Telegram's own stored MIME can be wrong for browsers; prefer the indexed value.
    "Content-Type": upstream.headers.get("content-type") ?? target.mime_type,
    "Accept-Ranges": "bytes",
    // Private media must never land in shared caches.
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  });
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (upstream.status === 416) {
    return new Response(null, { status: 416, headers });
  }
  if (method === "HEAD" || !upstream.body) {
    return new Response(null, { status: upstream.status, headers });
  }

  activeStreams.set(ip, (activeStreams.get(ip) ?? 0) + 1);
  log("info", "stream_start", { status: upstream.status, range: c.req.header("range") ?? null });
  return new Response(trackStream(upstream.body, ip), { status: upstream.status, headers });
}

publicRoutes.get("/stream/:publicId", handleStream);
publicRoutes.on("HEAD", "/stream/:publicId", handleStream);
