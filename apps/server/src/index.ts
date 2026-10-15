import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../../api/src/app";
import type { Bindings } from "../../api/src/env";
import { log } from "../../api/src/lib/log";
import { purgeOldData } from "../../api/src/lib/retention";
import { runSyncTick, scheduleIncremental } from "../../api/src/lib/sync";
import { loadConfig } from "./config";
import { migrate, SqliteD1 } from "./sqlite-d1";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();

const migrationsDir = [cfg.MIGRATIONS_DIR, join(here, "../../../migrations"), join(process.cwd(), "migrations")].find((d) => d && existsSync(d));
if (!migrationsDir) throw new Error("migrations directory not found (set MIGRATIONS_DIR)");

const db = new SqliteD1(cfg.DATABASE_FILE);
const applied = migrate(db, migrationsDir);
if (applied.length) log("info", "migrations_applied", { files: applied });

const bindings = {
  DB: db as unknown as D1Database,
  APP_ORIGIN: cfg.APP_ORIGIN,
  API_PUBLIC_URL: cfg.API_PUBLIC_URL,
  TG_SERVICE_URL: cfg.TG_SERVICE_URL,
  TG_SERVICE_SECRET: cfg.TG_SERVICE_SECRET,
  PLAYBACK_SECRET: cfg.PLAYBACK_SECRET,
  SETUP_TOKEN: cfg.SETUP_TOKEN,
  PASSWORD_PEPPER: cfg.PASSWORD_PEPPER,
  ENVIRONMENT: cfg.ENVIRONMENT,
  COOKIE_SAMESITE: cfg.COOKIE_SAMESITE,
} satisfies Omit<Bindings, "DB"> & { DB: D1Database };

/** Node equivalent of Workers' ExecutionContext: background work that must not fail a request. */
const executionCtx = {
  waitUntil(p: Promise<unknown>) {
    p.catch((err) => log("error", "background_task_failed", { error: err instanceof Error ? err.message : String(err) }));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

/** Resolve the real client address once, here, so rate limits and stream caps cannot be spoofed with headers. */
function clientIp(req: Request, incoming: IncomingMessage | undefined): string {
  if (cfg.TRUST_CLOUDFLARE) {
    const cf = req.headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
  }
  if (cfg.TRUST_PROXY) {
    const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  return incoming?.socket?.remoteAddress ?? "local";
}

const app = createApp();

const server = serve(
  {
    fetch: (req: Request, nodeEnv?: { incoming?: IncomingMessage }) =>
      app.fetch(req, { ...bindings, CLIENT_IP: clientIp(req, nodeEnv?.incoming) }, executionCtx),
    port: cfg.PORT,
    hostname: cfg.HOST,
  },
  (info) => log("info", "api_listening", { port: info.port }),
);
// Long video responses must not be cut by Node's default 5-minute request timeout.
server.setTimeout?.(0);
(server as unknown as { requestTimeout?: number }).requestTimeout = 0;
(server as unknown as { keepAliveTimeout?: number }).keepAliveTimeout = 75_000;

/* ───────── background work (replaces the Cloudflare cron trigger) ───────── */
let ticks = 0;
let busy = false;
async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const n = ticks++;
    if (n % 5 === 0) await scheduleIncremental(bindings as unknown as Bindings);
    if (n % 1440 === 17) await purgeOldData(bindings as unknown as Bindings);
    await runSyncTick(bindings as unknown as Bindings);
  } catch (err) {
    log("error", "cron_failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    busy = false;
  }
}
const timer = setInterval(() => void tick(), 60_000);
timer.unref();
setTimeout(() => void tick(), 10_000).unref(); // pick up unfinished jobs shortly after a restart

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("info", "shutting_down", { sig });
    clearInterval(timer);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
process.on("unhandledRejection", (e) => log("error", "unhandled_rejection", { error: e instanceof Error ? e.message : String(e) }));
