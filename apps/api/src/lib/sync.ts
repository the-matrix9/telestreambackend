import type { IndexedVideo, JobType, SyncJobDTO } from "@telestream/shared";
import type { Bindings } from "../env";
import { HttpError } from "./errors";
import { log } from "./log";
import { TelegramService } from "./telegram";
import { bumpCatalogVersion } from "./videos";

/**
 * Sync engine. A job advances in small bounded steps (one history page, or one verification batch)
 * so it never holds the whole channel in memory and can resume from `cursor` after any crash.
 * Every write is an upsert keyed on (channel_id, telegram_message_id), which makes steps idempotent.
 */
const PAGE_SIZE = 100;
const VERIFY_BATCH = 50;
const MAX_ATTEMPTS = 5;
const STALE_AFTER_SECONDS = 120;
const BUDGET_MS = 25_000;

interface JobRow {
  id: number;
  channel_id: number;
  job_type: JobType;
  status: string;
  cursor: string | null;
  floor_message_id: number;
  target_video_id: number | null;
  processed_count: number;
  attempts: number;
  telegram_channel_id: string;
}

const now = () => Math.floor(Date.now() / 1000);

export function rowToJob(r: Record<string, unknown>): SyncJobDTO {
  return {
    id: r.id as number,
    channelId: r.channel_id as number,
    jobType: r.job_type as JobType,
    status: r.status as SyncJobDTO["status"],
    processedCount: r.processed_count as number,
    errorMessage: (r.error_message as string | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    completedAt: (r.completed_at as number | null) ?? null,
    createdAt: r.created_at as number,
    attempts: r.attempts as number,
  };
}

/** Creates a job unless an active one already exists for the channel (prevents duplicate crawls). */
export async function enqueueJob(
  env: Bindings,
  channelId: number,
  type: JobType,
  opts: { targetVideoId?: number } = {},
): Promise<{ id: number; created: boolean }> {
  const active = await env.DB.prepare(
    "SELECT id FROM sync_jobs WHERE channel_id = ? AND status IN ('pending','running') AND job_type != 'reindex' LIMIT 1",
  ).bind(channelId).first<{ id: number }>();
  if (active && type !== "reindex") return { id: active.id, created: false };

  let floor = 0;
  if (type === "incremental") {
    const r = await env.DB.prepare("SELECT COALESCE(MAX(telegram_message_id), 0) AS m FROM videos WHERE channel_id = ?")
      .bind(channelId).first<{ m: number }>();
    floor = r?.m ?? 0;
  }
  const res = await env.DB.prepare(
    "INSERT INTO sync_jobs (channel_id, job_type, status, floor_message_id, target_video_id) VALUES (?, ?, 'pending', ?, ?) RETURNING id",
  ).bind(channelId, type, floor, opts.targetVideoId ?? null).first<{ id: number }>();
  await env.DB.prepare("UPDATE channels SET sync_status = 'pending' WHERE id = ? AND sync_status != 'syncing'").bind(channelId).run();
  return { id: res!.id, created: true };
}

/** Re-queue a failed job as a fresh job that resumes from where the failed one stopped. */
export async function retryJob(env: Bindings, jobId: number): Promise<number> {
  const j = await env.DB.prepare("SELECT * FROM sync_jobs WHERE id = ?").bind(jobId).first<Record<string, unknown>>();
  if (!j) throw new HttpError(404, "not_found", "Job not found");
  if (j.status !== "failed" && j.status !== "cancelled") throw new HttpError(409, "conflict", "Only failed or cancelled jobs can be retried");
  const active = await env.DB.prepare(
    "SELECT id FROM sync_jobs WHERE channel_id = ? AND status IN ('pending','running') AND job_type != 'reindex' LIMIT 1",
  ).bind(j.channel_id).first();
  if (active) throw new HttpError(409, "conflict", "Another sync is already active for this channel");
  const res = await env.DB.prepare(
    `INSERT INTO sync_jobs (channel_id, job_type, status, cursor, floor_message_id, target_video_id, processed_count)
     VALUES (?, ?, 'pending', ?, ?, ?, ?) RETURNING id`,
  ).bind(j.channel_id, j.job_type, j.cursor, j.floor_message_id, j.target_video_id, j.processed_count).first<{ id: number }>();
  await env.DB.prepare("UPDATE channels SET sync_status = 'pending' WHERE id = ?").bind(j.channel_id).run();
  return res!.id;
}

async function claimNext(env: Bindings): Promise<JobRow | null> {
  const t = now();
  // Claim atomically: pending jobs, or running jobs whose worker vanished (stale heartbeat).
  const row = await env.DB.prepare(
    `UPDATE sync_jobs SET status = 'running', started_at = COALESCE(started_at, ?1), heartbeat_at = ?1
      WHERE id = (SELECT id FROM sync_jobs
                   WHERE status = 'pending' OR (status = 'running' AND COALESCE(heartbeat_at, 0) < ?1 - ?2)
                   ORDER BY id LIMIT 1)
      RETURNING id`,
  ).bind(t, STALE_AFTER_SECONDS).first<{ id: number }>();
  if (!row) return null;
  return env.DB.prepare(
    `SELECT j.*, c.telegram_channel_id FROM sync_jobs j JOIN channels c ON c.id = j.channel_id WHERE j.id = ?`,
  ).bind(row.id).first<JobRow>();
}

export async function upsertVideos(env: Bindings, channelId: number, videos: IndexedVideo[]): Promise<number> {
  if (!videos.length) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO videos (channel_id, telegram_message_id, title, description, tags, duration_seconds, file_size_bytes,
                         mime_type, width, height, thumbnail_reference, published_at, availability_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, telegram_message_id) DO UPDATE SET
       title = excluded.title, description = excluded.description, tags = excluded.tags,
       duration_seconds = excluded.duration_seconds, file_size_bytes = excluded.file_size_bytes,
       mime_type = excluded.mime_type, width = excluded.width, height = excluded.height,
       thumbnail_reference = excluded.thumbnail_reference, availability_status = excluded.availability_status`,
  );
  // D1 batches run as a single transaction.
  await env.DB.batch(
    videos.map((v) =>
      stmt.bind(
        channelId, v.messageId, v.title.slice(0, 300), v.description.slice(0, 4000), v.tags.join(" ").slice(0, 500),
        v.durationSeconds, v.fileSizeBytes, v.mimeType.slice(0, 100), v.width, v.height,
        v.hasThumbnail ? "tg" : null, v.publishedAt, v.supported ? "available" : "unsupported",
      ),
    ),
  );
  return videos.length;
}

async function stepHistory(env: Bindings, tg: TelegramService, job: JobRow): Promise<boolean> {
  const offsetId = job.cursor ? Number(job.cursor) : 0; // 0 = start from newest
  const page = await tg.historyPage(job.telegram_channel_id, offsetId, job.floor_message_id, PAGE_SIZE);
  const n = await upsertVideos(env, job.channel_id, page.videos);
  const done = page.done || page.nextOffsetId === null;
  await env.DB.prepare(
    "UPDATE sync_jobs SET cursor = ?, processed_count = processed_count + ?, heartbeat_at = ?, attempts = 0 WHERE id = ?",
  ).bind(page.nextOffsetId === null ? job.cursor : String(page.nextOffsetId), n, now(), job.id).run();
  return done;
}

async function stepVerify(env: Bindings, tg: TelegramService, job: JobRow): Promise<boolean> {
  const after = job.cursor ? Number(job.cursor) : 0;
  const { results } = await env.DB.prepare(
    "SELECT id, telegram_message_id, availability_status FROM videos WHERE channel_id = ? AND id > ? ORDER BY id LIMIT ?",
  ).bind(job.channel_id, after, VERIFY_BATCH).all<{ id: number; telegram_message_id: number; availability_status: string }>();
  if (!results.length) return true;
  const res = await tg.getMessages(job.telegram_channel_id, results.map((r) => r.telegram_message_id));
  const byId = new Map(res.items.map((i) => [i.messageId, i]));
  const stmts = [];
  for (const row of results) {
    const item = byId.get(row.telegram_message_id);
    let status = "available";
    if (!item || !item.exists) status = "deleted";
    else if (!item.video || !item.video.supported) status = "unsupported";
    if (status !== row.availability_status) {
      stmts.push(env.DB.prepare("UPDATE videos SET availability_status = ? WHERE id = ?").bind(status, row.id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  const last = results[results.length - 1]!;
  await env.DB.prepare("UPDATE sync_jobs SET cursor = ?, processed_count = processed_count + ?, heartbeat_at = ?, attempts = 0 WHERE id = ?")
    .bind(String(last.id), results.length, now(), job.id).run();
  return results.length < VERIFY_BATCH;
}

async function stepReindex(env: Bindings, tg: TelegramService, job: JobRow): Promise<boolean> {
  const v = await env.DB.prepare("SELECT id, telegram_message_id FROM videos WHERE id = ?").bind(job.target_video_id).first<{ id: number; telegram_message_id: number }>();
  if (!v) return true;
  const res = await tg.getMessages(job.telegram_channel_id, [v.telegram_message_id]);
  const item = res.items[0];
  if (!item || !item.exists) {
    await env.DB.prepare("UPDATE videos SET availability_status = 'deleted' WHERE id = ?").bind(v.id).run();
  } else if (!item.video) {
    await env.DB.prepare("UPDATE videos SET availability_status = 'unsupported' WHERE id = ?").bind(v.id).run();
  } else {
    await upsertVideos(env, job.channel_id, [item.video]);
  }
  await env.DB.prepare("UPDATE sync_jobs SET processed_count = 1 WHERE id = ?").bind(job.id).run();
  return true;
}

async function finishJob(env: Bindings, job: JobRow): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE sync_jobs SET status = 'completed', completed_at = ?, error_message = NULL WHERE id = ?").bind(t, job.id),
    env.DB.prepare(
      `UPDATE channels SET last_synced_at = ?1,
         sync_status = CASE WHEN EXISTS (SELECT 1 FROM sync_jobs WHERE channel_id = ?2 AND id != ?3 AND status IN ('pending','running') AND job_type != 'reindex')
                            THEN 'pending' ELSE 'idle' END
       WHERE id = ?2`,
    ).bind(t, job.channel_id, job.id),
  ]);
  await bumpCatalogVersion(env);
  const done = await env.DB.prepare("SELECT processed_count FROM sync_jobs WHERE id = ?").bind(job.id).first<{ processed_count: number }>();
  log("info", "sync_job_completed", { jobId: job.id, type: job.job_type, processed: done?.processed_count ?? 0 });
}

async function failJob(env: Bindings, job: JobRow, err: unknown): Promise<void> {
  const http = err instanceof HttpError ? err : null;
  const message = (http?.message ?? (err instanceof Error ? err.message : "Unknown error")).slice(0, 500);
  const transient = http?.transient ?? false;
  const attempts = job.attempts + 1;
  if (transient && attempts < MAX_ATTEMPTS) {
    // Exponential backoff via heartbeat: the claim query skips it until the delay elapses.
    const delay = Math.min(300, 2 ** attempts * 5) + (http?.headers?.["Retry-After"] ? Number(http.headers["Retry-After"]) || 0 : 0);
    await env.DB.prepare(
      "UPDATE sync_jobs SET status = 'running', attempts = ?, error_message = ?, heartbeat_at = ? WHERE id = ?",
    ).bind(attempts, message, now() - STALE_AFTER_SECONDS + delay, job.id).run();
    log("warn", "sync_job_retry", { jobId: job.id, attempts, delay });
    return;
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE sync_jobs SET status = 'failed', attempts = ?, error_message = ?, completed_at = ? WHERE id = ?").bind(attempts, message, now(), job.id),
    env.DB.prepare("UPDATE channels SET sync_status = 'error' WHERE id = ?").bind(job.channel_id),
  ]);
  log("error", "sync_job_failed", { jobId: job.id, error: message });
}

/** Runs queued work until the time budget is spent. Safe to call concurrently (jobs are claimed atomically). */
export async function runSyncTick(env: Bindings, budgetMs = BUDGET_MS): Promise<number> {
  const tg = new TelegramService(env);
  const deadline = Date.now() + budgetMs;
  let steps = 0;
  while (Date.now() < deadline) {
    const job = await claimNext(env);
    if (!job) break;
    await env.DB.prepare("UPDATE channels SET sync_status = 'syncing' WHERE id = ?").bind(job.channel_id).run();
    try {
      let done = false;
      if (job.job_type === "verify") done = await stepVerify(env, tg, job);
      else if (job.job_type === "reindex") done = await stepReindex(env, tg, job);
      else done = await stepHistory(env, tg, job);
      steps++;
      if (done) await finishJob(env, job);
      else await env.DB.prepare("UPDATE sync_jobs SET status = 'pending' WHERE id = ?").bind(job.id).run();
    } catch (err) {
      await failJob(env, job, err);
      break; // let backoff elapse instead of hammering a failing upstream
    }
  }
  return steps;
}

/** Enqueue incremental syncs for every confirmed channel that is idle. */
export async function scheduleIncremental(env: Bindings): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM channels c WHERE import_confirmed = 1 AND sync_status IN ('idle','error')
       AND EXISTS (SELECT 1 FROM videos v WHERE v.channel_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM sync_jobs j WHERE j.channel_id = c.id AND j.status IN ('pending','running'))`,
  ).all<{ id: number }>();
  for (const r of results) await enqueueJob(env, r.id, "incremental");
}
