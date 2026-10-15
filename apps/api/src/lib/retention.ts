import type { Bindings } from "../env";

/** Retention: watch positions are kept 180 days (stated in the Privacy page); old rate-limit rows and finished jobs are trimmed. */
export const WATCH_HISTORY_RETENTION_DAYS = 180;
export async function purgeOldData(env: Bindings): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM watch_history WHERE updated_at < unixepoch() - ?").bind(WATCH_HISTORY_RETENTION_DAYS * 86_400),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < unixepoch() - 86400"),
    env.DB.prepare("DELETE FROM sync_jobs WHERE status IN ('completed','cancelled') AND completed_at < unixepoch() - 90 * 86400"),
  ]);
}
