import { serve } from "@hono/node-server";
import { createServiceApp } from "./app";
import { loadConfig } from "./config";
import { GramjsGateway } from "./gramjs";
import { log } from "./logger";
import { StreamSlots } from "./streaming";
import { parseKey, SessionVault } from "./vault";

const cfg = loadConfig();
const vault = new SessionVault(
  cfg.SESSION_FILE,
  parseKey(cfg.SESSION_ENCRYPTION_KEY),
  cfg.SESSION_ENCRYPTION_KEY_PREVIOUS ? parseKey(cfg.SESSION_ENCRYPTION_KEY_PREVIOUS, "SESSION_ENCRYPTION_KEY_PREVIOUS") : undefined,
);
const gateway = new GramjsGateway(cfg, vault);
const slots = new StreamSlots(cfg.MAX_CONCURRENT_STREAMS);

const app = createServiceApp({
  gateway,
  serviceSecret: cfg.TG_SERVICE_SECRET,
  slots,
  limits: { maxRangeBytes: cfg.MAX_RANGE_BYTES, chunkTimeoutMs: cfg.CHUNK_TIMEOUT_MS },
});

const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => {
  log("info", "telegram_service_listening", { port: info.port });
});

// Restore the saved session in the background so the HTTP server is healthy immediately.
void gateway.init();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("info", "shutting_down", { sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
process.on("unhandledRejection", (e) => log("error", "unhandled_rejection", { error: e instanceof Error ? e.message : String(e) }));
