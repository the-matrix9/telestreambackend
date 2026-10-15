import {
  adminLoginSchema,
  adminSetupSchema,
  adminVideoQuerySchema,
  auditQuerySchema,
  channelCreateSchema,
  jobListQuerySchema,
  requestCodeSchema,
  safeEqual,
  syncStartSchema,
  verifyCodeSchema,
  verifyPasswordSchema,
  type ChannelDTO,
  type TelegramServiceStatus,
} from "@telestream/shared";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { audit, listAudit } from "../lib/audit";
import { conflict, forbidden, HttpError, notFound, parseWith, unauthorized } from "../lib/errors";
import { dummyVerify, hashPassword, verifyPassword } from "../lib/password";
import { limitStrict, resetStrict } from "../lib/ratelimit";
import { createSession, destroyAllSessionsForUser, destroySession, loadSession } from "../lib/session";
import { enqueueJob, retryJob, rowToJob, runSyncTick } from "../lib/sync";
import { TelegramService } from "../lib/telegram";
import { getSetting, getStreamTarget, listVideos, toAdminDTO } from "../lib/videos";
import { readJson, requireAdmin, requireTrustedOrigin } from "../middleware/security";

export const adminRoutes = new Hono<AppEnv>();

/* ───────────── auth (unauthenticated endpoints) ───────────── */

adminRoutes.get("/auth/me", async (c) => {
  c.header("Cache-Control", "no-store");
  const session = await loadSession(c);
  if (session) return c.json({ authenticated: true, username: session.username, csrf: session.csrf, setupRequired: false });
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_users").first<{ n: number }>();
  return c.json({ authenticated: false, setupRequired: (row?.n ?? 0) === 0 });
});

/** First-run only: creates the initial administrator, gated by the SETUP_TOKEN secret. */
adminRoutes.post("/auth/setup", requireTrustedOrigin, async (c) => {
  const ip = c.get("ip");
  await limitStrict(c.env, `setup:${ip}`, 5, 900);
  const body = parseWith(adminSetupSchema, await readJson(c));
  if (!c.env.SETUP_TOKEN || !safeEqual(body.setupToken, c.env.SETUP_TOKEN)) {
    await audit(c.env, { actor: null, action: "admin.setup_failed", ip });
    throw forbidden("Invalid setup token");
  }
  const hash = await hashPassword(body.password, c.env.PASSWORD_PEPPER ?? "");
  // Atomic "only if no admin exists" so two simultaneous setups cannot both win.
  const res = await c.env.DB.prepare(
    "INSERT INTO admin_users (username, password_hash) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM admin_users) RETURNING id",
  ).bind(body.username, hash).first<{ id: number }>();
  if (!res) throw conflict("An administrator already exists. Sign in instead.");
  await audit(c.env, { actor: body.username, action: "admin.setup_completed", ip });
  const { csrf } = await createSession(c, res.id);
  await c.env.DB.prepare("UPDATE admin_users SET last_login_at = unixepoch() WHERE id = ?").bind(res.id).run();
  return c.json({ authenticated: true, username: body.username, csrf, setupRequired: false }, 201);
});

adminRoutes.post("/auth/login", requireTrustedOrigin, async (c) => {
  const ip = c.get("ip");
  const body = parseWith(adminLoginSchema, await readJson(c));
  const userKey = `login:u:${body.username.toLowerCase()}`;
  await limitStrict(c.env, `login:ip:${ip}`, 15, 900);
  await limitStrict(c.env, userKey, 6, 900);

  const user = await c.env.DB.prepare("SELECT id, username, password_hash FROM admin_users WHERE username = ?")
    .bind(body.username).first<{ id: number; username: string; password_hash: string }>();
  const pepper = c.env.PASSWORD_PEPPER ?? "";
  const ok = user ? await verifyPassword(body.password, user.password_hash, pepper) : await dummyVerify(body.password, pepper);
  if (!user || !ok) {
    await audit(c.env, { actor: body.username, action: "admin.login_failed", ip });
    throw unauthorized("Invalid username or password");
  }
  await resetStrict(c.env, userKey);
  const { csrf } = await createSession(c, user.id);
  await c.env.DB.prepare("UPDATE admin_users SET last_login_at = unixepoch() WHERE id = ?").bind(user.id).run();
  await audit(c.env, { actor: user.username, action: "admin.login", ip });
  return c.json({ authenticated: true, username: user.username, csrf, setupRequired: false });
});

/* ───────────── everything below requires a session + CSRF ───────────── */

const guarded = new Hono<AppEnv>();
guarded.use("*", requireAdmin);

guarded.post("/auth/logout", async (c) => {
  const admin = c.get("admin")!;
  await destroySession(c);
  await audit(c.env, { actor: admin.username, action: "admin.logout", ip: c.get("ip") });
  return c.body(null, 204);
});

guarded.post("/auth/revoke-all-sessions", async (c) => {
  const admin = c.get("admin")!;
  await destroyAllSessionsForUser(c.env, admin.userId);
  await audit(c.env, { actor: admin.username, action: "admin.sessions_revoked", ip: c.get("ip") });
  return c.body(null, 204);
});

/* ───────────── Telegram connection ───────────── */

async function persistAccount(c: import("hono").Context<AppEnv>, st: TelegramServiceStatus): Promise<void> {
  const existing = await c.env.DB.prepare("SELECT id FROM telegram_accounts ORDER BY id LIMIT 1").first<{ id: number }>();
  const ref = st.status === "connected" ? "vault:default" : null;
  if (existing) {
    await c.env.DB.prepare(
      "UPDATE telegram_accounts SET status = ?, account_label = COALESCE(?, account_label), encrypted_session_reference = ?, updated_at = unixepoch() WHERE id = ?",
    ).bind(st.status, st.accountLabel, ref, existing.id).run();
  } else {
    await c.env.DB.prepare("INSERT INTO telegram_accounts (account_label, encrypted_session_reference, status) VALUES (?, ?, ?)")
      .bind(st.accountLabel ?? "Telegram account", ref, st.status).run();
  }
}

guarded.get("/telegram/status", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const st = await new TelegramService(c.env).status();
    await persistAccount(c, st);
    return c.json(st);
  } catch (err) {
    const message = err instanceof HttpError ? err.message : "Telegram service unreachable";
    return c.json({ status: "error", accountLabel: null, lastError: message, hint: "Check that apps/telegram-service is running and TG_SERVICE_URL / TG_SERVICE_SECRET are correct." });
  }
});

guarded.post("/telegram/login/request-code", async (c) => {
  const admin = c.get("admin")!;
  await limitStrict(c.env, `tglogin:${admin.userId}`, 5, 900);
  const { phone } = parseWith(requestCodeSchema, await readJson(c));
  const st = await new TelegramService(c.env).requestCode(phone);
  await persistAccount(c, st);
  // The phone number is deliberately not written to the audit log.
  await audit(c.env, { actor: admin.username, action: "telegram.login_code_requested", ip: c.get("ip") });
  return c.json(st);
});

guarded.post("/telegram/login/verify-code", async (c) => {
  const admin = c.get("admin")!;
  await limitStrict(c.env, `tgcode:${admin.userId}`, 8, 900);
  const { code } = parseWith(verifyCodeSchema, await readJson(c));
  const st = await new TelegramService(c.env).verifyCode(code);
  await persistAccount(c, st);
  await audit(c.env, { actor: admin.username, action: st.status === "connected" ? "telegram.connected" : "telegram.code_verified", ip: c.get("ip") });
  return c.json(st);
});

guarded.post("/telegram/login/verify-password", async (c) => {
  const admin = c.get("admin")!;
  await limitStrict(c.env, `tgpw:${admin.userId}`, 8, 900);
  const { password } = parseWith(verifyPasswordSchema, await readJson(c));
  const st = await new TelegramService(c.env).verifyPassword(password);
  await persistAccount(c, st);
  await audit(c.env, { actor: admin.username, action: "telegram.connected", ip: c.get("ip") });
  return c.json(st);
});

guarded.post("/telegram/logout", async (c) => {
  const admin = c.get("admin")!;
  const st = await new TelegramService(c.env).logout();
  await persistAccount(c, st);
  await audit(c.env, { actor: admin.username, action: "telegram.logout", ip: c.get("ip") });
  return c.json(st);
});

/* ───────────── channels ───────────── */

const CHANNEL_SQL = `SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.availability_status = 'available') AS video_count FROM channels c`;

function channelDTO(r: Record<string, unknown>): ChannelDTO {
  return {
    id: r.id as number,
    telegramChannelId: r.telegram_channel_id as string,
    title: (r.title as string | null) ?? null,
    username: (r.username as string | null) ?? null,
    syncStatus: r.sync_status as ChannelDTO["syncStatus"],
    lastSyncedAt: (r.last_synced_at as number | null) ?? null,
    importConfirmed: r.import_confirmed === 1,
    videoCount: (r.video_count as number) ?? 0,
  };
}

guarded.get("/channels", async (c) => {
  const { results } = await c.env.DB.prepare(`${CHANNEL_SQL} ORDER BY c.id`).all<Record<string, unknown>>();
  return c.json({ items: results.map(channelDTO) });
});

guarded.post("/channels", async (c) => {
  const admin = c.get("admin")!;
  const { channel } = parseWith(channelCreateSchema, await readJson(c));
  // Validates that the connected account can actually read this channel.
  const resolved = await new TelegramService(c.env).resolveChannel(channel);
  const acct = await c.env.DB.prepare("SELECT id FROM telegram_accounts ORDER BY id LIMIT 1").first<{ id: number }>();
  const row = await c.env.DB.prepare(
    `INSERT INTO channels (telegram_channel_id, telegram_account_id, title, username) VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_channel_id) DO UPDATE SET title = excluded.title, username = excluded.username
     RETURNING id`,
  ).bind(resolved.telegramChannelId, acct?.id ?? null, resolved.title, resolved.username).first<{ id: number }>();
  await audit(c.env, { actor: admin.username, action: "channel.configured", target: resolved.telegramChannelId, ip: c.get("ip") });
  const full = await c.env.DB.prepare(`${CHANNEL_SQL} WHERE c.id = ?`).bind(row!.id).first<Record<string, unknown>>();
  return c.json(channelDTO(full!), 201);
});

guarded.post("/channels/:id/sync", async (c) => {
  const admin = c.get("admin")!;
  const id = Number(c.req.param("id"));
  const body = parseWith(syncStartSchema, await readJson(c)); // `confirm: true` is mandatory
  const ch = await c.env.DB.prepare("SELECT id, telegram_channel_id FROM channels WHERE id = ?").bind(id).first<{ id: number; telegram_channel_id: string }>();
  if (!ch) throw notFound("Channel not found");
  await c.env.DB.prepare("UPDATE channels SET import_confirmed = 1 WHERE id = ?").bind(id).run();
  const { id: jobId, created } = await enqueueJob(c.env, id, body.mode);
  await audit(c.env, { actor: admin.username, action: "channel.sync_started", target: ch.telegram_channel_id, ip: c.get("ip"), metadata: { mode: body.mode, jobId } });
  if (created) c.executionCtx.waitUntil(runSyncTick(c.env).then(() => undefined).catch(() => undefined));
  return c.json({ jobId, created }, created ? 202 : 200);
});

/* ───────────── jobs ───────────── */

guarded.get("/sync-jobs", async (c) => {
  const q = parseWith(jobListQuerySchema, c.req.query());
  const { results } = q.status
    ? await c.env.DB.prepare("SELECT * FROM sync_jobs WHERE status = ? ORDER BY id DESC LIMIT ?").bind(q.status, q.limit).all<Record<string, unknown>>()
    : await c.env.DB.prepare("SELECT * FROM sync_jobs ORDER BY id DESC LIMIT ?").bind(q.limit).all<Record<string, unknown>>();
  c.header("Cache-Control", "no-store");
  return c.json({ items: results.map(rowToJob) });
});

guarded.post("/sync-jobs/:id/retry", async (c) => {
  const admin = c.get("admin")!;
  const jobId = await retryJob(c.env, Number(c.req.param("id")));
  await audit(c.env, { actor: admin.username, action: "sync.retry", target: String(c.req.param("id")), ip: c.get("ip") });
  c.executionCtx.waitUntil(runSyncTick(c.env).then(() => undefined).catch(() => undefined));
  return c.json({ jobId }, 202);
});

guarded.post("/sync-jobs/:id/cancel", async (c) => {
  const admin = c.get("admin")!;
  const id = Number(c.req.param("id"));
  const res = await c.env.DB.prepare(
    "UPDATE sync_jobs SET status = 'cancelled', completed_at = unixepoch() WHERE id = ? AND status IN ('pending','running') RETURNING channel_id",
  ).bind(id).first<{ channel_id: number }>();
  if (!res) throw conflict("Job is not active");
  await c.env.DB.prepare("UPDATE channels SET sync_status = 'idle' WHERE id = ?").bind(res.channel_id).run();
  await audit(c.env, { actor: admin.username, action: "sync.cancelled", target: String(id), ip: c.get("ip") });
  return c.body(null, 204);
});

/* ───────────── videos ───────────── */

guarded.get("/videos", async (c) => {
  const q = parseWith(adminVideoQuerySchema, c.req.query());
  c.header("Cache-Control", "no-store");
  return c.json(await listVideos(c.env, q, { admin: true, status: q.status }, toAdminDTO));
});

/** Admin-only thumbnail (visitors never see thumbnails). Authenticated by the admin session cookie. */
guarded.get("/videos/:id/thumbnail", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) throw notFound();
  const target = await getStreamTarget(c.env, id);
  if (!target) throw notFound();
  const upstream = await new TelegramService(c.env).thumbnail(target.telegram_channel_id, target.telegram_message_id).catch((err) => {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) throw notFound("No thumbnail");
    throw err;
  });
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

guarded.post("/videos/:id/reindex", async (c) => {
  const admin = c.get("admin")!;
  const id = Number(c.req.param("id"));
  const v = await c.env.DB.prepare("SELECT id, channel_id FROM videos WHERE id = ?").bind(id).first<{ id: number; channel_id: number }>();
  if (!v) throw notFound("Video not found");
  const job = await enqueueJob(c.env, v.channel_id, "reindex", { targetVideoId: id });
  await audit(c.env, { actor: admin.username, action: "video.reindex", target: String(id), ip: c.get("ip") });
  c.executionCtx.waitUntil(runSyncTick(c.env).then(() => undefined).catch(() => undefined));
  return c.json({ jobId: job.id }, 202);
});

/* ───────────── overview, health, audit, settings ───────────── */

guarded.get("/overview", async (c) => {
  c.header("Cache-Control", "no-store");
  const week = Math.floor(Date.now() / 1000) - 7 * 86_400;
  const [byStatus, jobs, watch, viewers] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT availability_status AS s, COUNT(*) AS n FROM videos GROUP BY availability_status"),
    c.env.DB.prepare("SELECT status AS s, COUNT(*) AS n FROM sync_jobs GROUP BY status"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM watch_history WHERE updated_at >= ?").bind(week),
    c.env.DB.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM watch_history WHERE updated_at >= ?").bind(week),
  ]);
  const toMap = (r: D1Result) => Object.fromEntries((r.results as { s: string; n: number }[]).map((x) => [x.s, x.n]));
  return c.json({
    videos: toMap(byStatus!),
    jobs: toMap(jobs!),
    watchEvents7d: (watch!.results[0] as { n: number }).n,
    uniqueViewers7d: (viewers!.results[0] as { n: number }).n,
    watchHistoryEnabled: (await getSetting(c.env, "watch_history_enabled")) !== "false",
  });
});

guarded.get("/health", async (c) => {
  c.header("Cache-Control", "no-store");
  const started = Date.now();
  let db = false;
  try { await c.env.DB.prepare("SELECT 1").first(); db = true; } catch { /* reported below */ }
  const dbMs = Date.now() - started;
  let telegram: { ok: boolean; latencyMs: number; activeStreams?: number; error?: string };
  const t0 = Date.now();
  try {
    const h = await new TelegramService(c.env).health();
    telegram = { ok: h.ok, latencyMs: Date.now() - t0, activeStreams: h.activeStreams };
  } catch (err) {
    telegram = { ok: false, latencyMs: Date.now() - t0, error: err instanceof HttpError ? err.message : "unreachable" };
  }
  return c.json({ api: { ok: true }, database: { ok: db, latencyMs: dbMs }, telegramService: telegram, rateLimitStore: c.env.RATE_KV ? "kv" : "memory" });
});

guarded.get("/audit-log", async (c) => {
  const q = parseWith(auditQuerySchema, c.req.query());
  c.header("Cache-Control", "no-store");
  return c.json({ items: await listAudit(c.env, q.limit) });
});

guarded.put("/settings/watch-history", async (c) => {
  const admin = c.get("admin")!;
  const body = (await readJson(c)) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "validation_error", "`enabled` must be a boolean");
  await c.env.DB.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('watch_history_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
  ).bind(String(body.enabled)).run();
  await audit(c.env, { actor: admin.username, action: "settings.watch_history", metadata: { enabled: body.enabled }, ip: c.get("ip") });
  return c.body(null, 204);
});

adminRoutes.route("/", guarded);
