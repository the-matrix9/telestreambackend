import {
  decodeCursor,
  encodeCursor,
  type AdminVideoDTO,
  type AvailabilityStatus,
  type Page,
  type VideoDTO,
  type VideoListQuery,
} from "@telestream/shared";
import type { Bindings } from "../env";

export interface VideoRow {
  id: number;
  public_id: string;
  channel_id: number;
  telegram_message_id: number;
  title: string;
  description: string;
  tags: string;
  duration_seconds: number;
  file_size_bytes: number;
  mime_type: string;
  width: number | null;
  height: number | null;
  thumbnail_reference: string | null;
  published_at: number;
  indexed_at: number;
  availability_status: AvailabilityStatus;
  channel_title: string | null;
  progress?: number | null;
}

const SELECT = `v.id, v.public_id, v.channel_id, v.telegram_message_id, v.title, v.description, v.tags, v.duration_seconds,
  v.file_size_bytes, v.mime_type, v.width, v.height, v.thumbnail_reference, v.published_at, v.indexed_at,
  v.availability_status, c.title AS channel_title`;

export function toDTO(r: VideoRow): VideoDTO {
  const dto: VideoDTO = {
    id: r.id,
    title: r.title,
    description: r.description,
    tags: r.tags ? r.tags.split(" ").filter(Boolean) : [],
    durationSeconds: r.duration_seconds,
    fileSizeBytes: r.file_size_bytes,
    mimeType: r.mime_type,
    width: r.width,
    height: r.height,
    hasThumbnail: r.thumbnail_reference !== null,
    publishedAt: r.published_at,
    channelId: r.channel_id,
    channelTitle: r.channel_title,
  };
  if (r.progress != null) dto.progressSeconds = r.progress;
  return dto;
}

export function toAdminDTO(r: VideoRow): AdminVideoDTO {
  return { ...toDTO(r), publicId: r.public_id, telegramMessageId: r.telegram_message_id, availabilityStatus: r.availability_status, indexedAt: r.indexed_at };
}

/** Builds a safe FTS5 MATCH expression: only letters/digits survive, every token is quoted + prefix-matched. */
export function buildFtsQuery(q: string | undefined): string | null {
  if (!q) return null;
  const tokens = q.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length) return null;
  return tokens.slice(0, 8).map((t) => `"${t}"*`).join(" ");
}

export interface ListOptions {
  admin?: boolean;
  status?: AvailabilityStatus;
}

export async function listVideos<T extends VideoDTO>(
  env: Bindings,
  query: VideoListQuery,
  opts: ListOptions,
  map: (r: VideoRow) => T,
): Promise<Page<T>> {
  const fts = buildFtsQuery(query.q);
  if (query.q && !fts) return { items: [], nextCursor: null };
  const sort = query.sort ?? (fts ? "relevance" : "newest");
  const cursor = decodeCursor(query.cursor);
  const where: string[] = [];
  const params: unknown[] = [];

  if (!opts.admin) where.push("v.availability_status = 'available'");
  else if (opts.status) {
    where.push("v.availability_status = ?");
    params.push(opts.status);
  }
  if (query.channel) { where.push("v.channel_id = ?"); params.push(query.channel); }
  if (query.minDuration != null) { where.push("v.duration_seconds >= ?"); params.push(query.minDuration); }
  if (query.maxDuration != null) { where.push("v.duration_seconds <= ?"); params.push(query.maxDuration); }
  if (query.days != null) { where.push("v.published_at >= ?"); params.push(Math.floor(Date.now() / 1000) - query.days * 86_400); }

  const limit = query.limit;
  let sql: string;

  if (fts && sort === "relevance") {
    where.unshift("videos_fts MATCH ?");
    params.unshift(fts);
    const offset = cursor?.t === "o" ? cursor.o : 0;
    sql = `SELECT ${SELECT} FROM videos_fts JOIN videos v ON v.id = videos_fts.rowid JOIN channels c ON c.id = v.channel_id
           WHERE ${where.join(" AND ")} ORDER BY bm25(videos_fts, 10.0, 2.0, 5.0), v.id DESC LIMIT ? OFFSET ?`;
    params.push(limit + 1, offset);
    const { results } = await env.DB.prepare(sql).bind(...params).all<VideoRow>();
    const hasMore = results.length > limit;
    return {
      items: results.slice(0, limit).map(map),
      nextCursor: hasMore ? encodeCursor({ t: "o", o: offset + limit }) : null,
    };
  }

  if (fts) {
    where.push("v.id IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH ?)");
    params.push(fts);
  }
  const asc = sort === "oldest";
  if (cursor?.t === "k") {
    const op = asc ? ">" : "<";
    where.push(`(v.published_at ${op} ? OR (v.published_at = ? AND v.id ${op} ?))`);
    params.push(cursor.p, cursor.p, cursor.i);
  }
  const dir = asc ? "ASC" : "DESC";
  sql = `SELECT ${SELECT} FROM videos v JOIN channels c ON c.id = v.channel_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY v.published_at ${dir}, v.id ${dir} LIMIT ?`;
  params.push(limit + 1);
  const { results } = await env.DB.prepare(sql).bind(...params).all<VideoRow>();
  const hasMore = results.length > limit;
  const items = results.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map(map),
    nextCursor: hasMore && last ? encodeCursor({ t: "k", p: last.published_at, i: last.id }) : null,
  };
}

export async function getVideoRow(env: Bindings, id: number): Promise<VideoRow | null> {
  return env.DB.prepare(`SELECT ${SELECT} FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.id = ?`)
    .bind(id)
    .first<VideoRow>();
}

/** Internal lookup incl. the Telegram channel id string needed to proxy media. */
export async function getStreamTarget(env: Bindings, id: number) {
  return env.DB.prepare(
    `SELECT v.id, v.telegram_message_id, v.availability_status, v.mime_type, v.file_size_bytes, c.telegram_channel_id
       FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.id = ?`,
  )
    .bind(id)
    .first<{
      id: number;
      telegram_message_id: number;
      availability_status: AvailabilityStatus;
      mime_type: string;
      file_size_bytes: number;
      telegram_channel_id: string;
    }>();
}

/** Public lookup by the opaque id. Includes the duration (drives the stream-link lifetime) and what is needed to proxy media. */
export async function getPlayTarget(env: Bindings, publicId: string) {
  return env.DB.prepare(
    `SELECT v.id, v.public_id, v.duration_seconds, v.telegram_message_id, v.availability_status, v.mime_type, v.file_size_bytes, c.telegram_channel_id
       FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      id: number;
      public_id: string;
      duration_seconds: number;
      telegram_message_id: number;
      availability_status: AvailabilityStatus;
      mime_type: string;
      file_size_bytes: number;
      telegram_channel_id: string;
    }>();
}

/** previous = older neighbour, next = newer neighbour (episode order). */
export async function neighbours(env: Bindings, v: VideoRow): Promise<{ previousId: number | null; nextId: number | null }> {
  const [older, newer] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id FROM videos WHERE availability_status='available' AND channel_id=? AND (published_at < ? OR (published_at = ? AND id < ?))
       ORDER BY published_at DESC, id DESC LIMIT 1`,
    ).bind(v.channel_id, v.published_at, v.published_at, v.id),
    env.DB.prepare(
      `SELECT id FROM videos WHERE availability_status='available' AND channel_id=? AND (published_at > ? OR (published_at = ? AND id > ?))
       ORDER BY published_at ASC, id ASC LIMIT 1`,
    ).bind(v.channel_id, v.published_at, v.published_at, v.id),
  ]);
  return {
    previousId: (older!.results[0] as { id: number } | undefined)?.id ?? null,
    nextId: (newer!.results[0] as { id: number } | undefined)?.id ?? null,
  };
}

export async function relatedVideos(env: Bindings, v: VideoRow, limit = 12): Promise<VideoDTO[]> {
  const seen = new Set<number>([v.id]);
  const out: VideoRow[] = [];
  const tagTokens = v.tags.split(" ").filter(Boolean).slice(0, 5);
  if (tagTokens.length) {
    const match = tagTokens.map((t) => `"${t.replace(/[^\p{L}\p{N}]/gu, "")}"`).filter((t) => t !== '""').join(" OR ");
    if (match) {
      const { results } = await env.DB.prepare(
        `SELECT ${SELECT} FROM videos_fts JOIN videos v ON v.id = videos_fts.rowid JOIN channels c ON c.id = v.channel_id
         WHERE videos_fts MATCH ? AND v.availability_status='available' AND v.id != ?
         ORDER BY bm25(videos_fts, 1.0, 1.0, 10.0) LIMIT ?`,
      ).bind(`tags: (${match})`, v.id, limit).all<VideoRow>();
      for (const r of results) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
  }
  if (out.length < limit) {
    const { results } = await env.DB.prepare(
      `SELECT ${SELECT} FROM videos v JOIN channels c ON c.id = v.channel_id
       WHERE v.availability_status='available' AND v.channel_id = ? AND v.id != ?
       ORDER BY v.published_at DESC, v.id DESC LIMIT ?`,
    ).bind(v.channel_id, v.id, limit).all<VideoRow>();
    for (const r of results) if (out.length < limit && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  }
  return out.map(toDTO);
}

export async function trendingVideos(env: Bindings, limit = 12, days = 7): Promise<VideoDTO[]> {
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const { results } = await env.DB.prepare(
    `SELECT ${SELECT}, COUNT(w.id) AS plays
       FROM watch_history w JOIN videos v ON v.id = w.video_id JOIN channels c ON c.id = v.channel_id
      WHERE w.updated_at >= ? AND v.availability_status = 'available'
      GROUP BY v.id ORDER BY plays DESC, v.published_at DESC LIMIT ?`,
  ).bind(since, limit).all<VideoRow>();
  return results.map(toDTO);
}

export async function continueWatching(env: Bindings, visitorId: string, limit = 12): Promise<VideoDTO[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SELECT}, w.position_seconds AS progress
       FROM watch_history w JOIN videos v ON v.id = w.video_id JOIN channels c ON c.id = v.channel_id
      WHERE w.visitor_id = ? AND v.availability_status = 'available'
        AND w.position_seconds >= 5 AND (v.duration_seconds = 0 OR w.position_seconds < v.duration_seconds * 0.95)
      ORDER BY w.updated_at DESC LIMIT ?`,
  ).bind(visitorId, limit).all<VideoRow>();
  return results.map(toDTO);
}

export async function getProgress(env: Bindings, visitorId: string, videoId: number): Promise<number> {
  const r = await env.DB.prepare("SELECT position_seconds FROM watch_history WHERE visitor_id = ? AND video_id = ?")
    .bind(visitorId, videoId)
    .first<{ position_seconds: number }>();
  return r?.position_seconds ?? 0;
}

/* ───────── catalog version (cache invalidation) ───────── */
export async function getCatalogVersion(env: Bindings): Promise<string> {
  const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'catalog_version'").first<{ value: string }>();
  return r?.value ?? "0";
}

export async function bumpCatalogVersion(env: Bindings): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('catalog_version', '1', unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = unixepoch()`,
  ).run();
}

export async function getSetting(env: Bindings, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
