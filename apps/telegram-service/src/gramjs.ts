/* All GramJS usage is confined to this file. If the library is replaced (it is archived upstream —
 * see docs/ARCHITECTURE.md), this is the only module that needs to change. */
import type { HistoryPageResponse, ResolvedChannel, TelegramServiceStatus, TelegramStatus } from "@telestream/shared";
import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger.js";
import { computeCheck } from "telegram/Password.js";
import { StringSession } from "telegram/sessions/index.js";
import { getPeerId } from "telegram/Utils.js";
import type { Config } from "./config";
import { mapTelegramError, ServiceError } from "./errors";
import { normalizeChannelRef, type MessageGetItem, type TelegramGateway } from "./gateway";
import { log } from "./logger";
import { extractVideo, getDocument, isVideoDocument, type MessageLike } from "./media";
import type { MediaSource } from "./streaming";
import type { SessionVault } from "./vault";

/**
 * GramJS' `iterDownload` only unwraps a *Message* or *MessageMedia* — handing it a bare `Api.Document`
 * throws "Cannot cast Document to any kind of InputFileLocation". Build the location explicitly (this also
 * lets a refreshed file reference be used without re-wrapping the whole message).
 */
function fileLocationOf(doc: Api.Document): Api.InputDocumentFileLocation {
  return new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: "",
  });
}

const REQUEST_SIZE = 512 * 1024; // must divide 1 MiB and be a multiple of 4 KiB (MTProto upload.getFile rule)
const DOC_TTL_MS = 10 * 60_000;
const THUMB_TTL_MS = 15 * 60_000;
const PENDING_LOGIN_TTL_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_API_CONCURRENCY = 3;

type AnyMsg = Api.Message & MessageLike;

/** Bounded concurrency for metadata calls so indexing cannot trip Telegram flood limits. */
class Limiter {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; this.waiters.shift()?.(); }
  }
}

class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private readonly ttl: number, private readonly max: number) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.map.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: V): void {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(k, { v, exp: Date.now() + this.ttl });
  }
  delete(k: string): void { this.map.delete(k); }
}

interface DocEntry { doc: Api.Document; media: Api.TypeMessageMedia; size: number; mimeType: string }

const CONNECT_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new ServiceError(503, "telegram_unreachable", "This server couldn't reach Telegram. Check the service host's internet access and firewall (Telegram uses TCP port 443/80), then try again.", 5)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export class GramjsGateway implements TelegramGateway {
  private client: TelegramClient | null = null;
  private current: TelegramStatus = "disconnected";
  private accountLabel: string | null = null;
  private lastError: string | null = null;
  private pending: { phone: string; hash: string; at: number; attempts: number } | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly api = new Limiter(MAX_API_CONCURRENCY);
  private readonly docs = new TtlCache<DocEntry>(DOC_TTL_MS, 500);
  private readonly thumbs = new TtlCache<Uint8Array>(THUMB_TTL_MS, 300);

  constructor(private readonly cfg: Config, private readonly vault: SessionVault) {}

  /* ───────────── lifecycle ───────────── */

  private newClient(session: string): TelegramClient {
    const c = new TelegramClient(new StringSession(session), this.cfg.TG_API_ID, this.cfg.TG_API_HASH, {
      connectionRetries: 5,
      floodSleepThreshold: 10, // longer waits surface as 429 so the caller can back off instead of hanging
      deviceModel: "TeleStream",
      appVersion: "1.0",
    });
    c.setLogLevel(LogLevel.ERROR);
    return c;
  }

  /** Restore a saved session on boot. Never throws: failures become a visible status with automatic retry. */
  async init(): Promise<void> {
    let session: string | null;
    try {
      session = await this.vault.load();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "Vault unreadable");
      return;
    }
    if (!session) { this.current = "disconnected"; return; }
    try {
      const c = this.newClient(session);
      await c.connect();
      if (!(await c.checkAuthorization())) throw new ServiceError(401, "session_revoked", "The saved Telegram session is no longer valid. Sign in again.");
      this.client = c;
      this.accountLabel = await this.labelFor(c);
      this.current = "connected";
      this.lastError = null;
      log("info", "telegram_connected");
    } catch (err) {
      const mapped = mapTelegramError(err);
      if (mapped.code === "session_revoked") {
        await this.vault.destroy();
        this.client = null;
        this.fail(mapped.message, "disconnected");
        return;
      }
      this.fail(mapped.message);
      this.scheduleReconnect();
    }
  }

  private fail(message: string, state: TelegramStatus = "error"): void {
    this.current = state;
    this.lastError = message;
    log("warn", "telegram_not_ready", { state, message });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.init(); }, 30_000);
    this.reconnectTimer.unref?.();
  }

  private async labelFor(c: TelegramClient): Promise<string> {
    const me = (await c.getMe()) as Api.User;
    // Display name / username only — never the phone number.
    return me.username ? `@${me.username}` : [me.firstName, me.lastName].filter(Boolean).join(" ") || "Telegram account";
  }

  private requireClient(): TelegramClient {
    if (this.current !== "connected" || !this.client) {
      throw new ServiceError(503, "not_connected", this.current === "error" ? (this.lastError ?? "Telegram connection is down.") : "No Telegram account is connected yet.");
    }
    return this.client;
  }

  /* ───────────── login flow ───────────── */

  state(): TelegramStatus { return this.current; }

  status(): TelegramServiceStatus {
    const hints: Record<TelegramStatus, string> = {
      disconnected: "Enter your phone number to receive a Telegram login code.",
      awaiting_code: "Enter the code Telegram sent to your account.",
      awaiting_password: "This account has two-step verification. Enter your password.",
      connected: "Connected.",
      error: this.lastError ?? "Telegram is unreachable.",
    };
    return { status: this.current, accountLabel: this.accountLabel, hint: hints[this.current], lastError: this.lastError };
  }

  async requestCode(phone: string): Promise<TelegramServiceStatus> {
    if (this.current === "connected") throw new ServiceError(409, "already_connected", "A Telegram account is already connected. Log out first to switch accounts.");
    try {
      await this.client?.disconnect().catch(() => undefined);
      const c = this.newClient("");
      let phoneCodeHash: string;
      try {
        // GramJS retries connections for a long time; bound it so the admin gets an answer, not a hang.
        ({ phoneCodeHash } = await withTimeout(
          (async () => { await c.connect(); return c.sendCode({ apiId: this.cfg.TG_API_ID, apiHash: this.cfg.TG_API_HASH }, phone); })(),
          CONNECT_TIMEOUT_MS,
        ));
      } catch (err) {
        await c.disconnect().catch(() => undefined);
        await c.destroy().catch(() => undefined);
        throw err;
      }
      this.client = c;
      this.pending = { phone, hash: phoneCodeHash, at: Date.now(), attempts: 0 };
      this.current = "awaiting_code";
      this.lastError = null;
      return this.status();
    } catch (err) {
      throw mapTelegramError(err);
    }
  }

  private requirePending(): { phone: string; hash: string; at: number; attempts: number } {
    const p = this.pending;
    if (!p || !this.client) throw new ServiceError(409, "no_login_in_progress", "Request a login code first.");
    if (Date.now() - p.at > PENDING_LOGIN_TTL_MS) {
      this.pending = null;
      this.current = "disconnected";
      throw new ServiceError(409, "code_expired", "The login attempt expired. Request a new code.");
    }
    return p;
  }

  async verifyCode(code: string): Promise<TelegramServiceStatus> {
    const p = this.requirePending();
    if (this.current !== "awaiting_code") throw new ServiceError(409, "wrong_state", "Not waiting for a login code.");
    if (++p.attempts > MAX_CODE_ATTEMPTS) {
      this.pending = null;
      this.current = "disconnected";
      throw new ServiceError(429, "too_many_attempts", "Too many incorrect codes. Request a new one.", 60);
    }
    try {
      const res = await this.client!.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.hash, phoneCode: code }));
      if (res.className === "auth.AuthorizationSignUpRequired") {
        throw new ServiceError(400, "not_registered", "That phone number is not registered on Telegram.");
      }
      await this.finalize();
      return this.status();
    } catch (err) {
      const mapped = mapTelegramError(err);
      if (mapped.code === "password_required") {
        this.current = "awaiting_password";
        return this.status();
      }
      throw mapped;
    }
  }

  async verifyPassword(password: string): Promise<TelegramServiceStatus> {
    this.requirePending();
    if (this.current !== "awaiting_password") throw new ServiceError(409, "wrong_state", "Not waiting for a two-step verification password.");
    try {
      const pwd = await this.client!.invoke(new Api.account.GetPassword());
      const check = await computeCheck(pwd, password);
      await this.client!.invoke(new Api.auth.CheckPassword({ password: check }));
      await this.finalize();
      return this.status();
    } catch (err) {
      throw mapTelegramError(err);
    }
  }

  private async finalize(): Promise<void> {
    const c = this.client!;
    const session = (c.session as StringSession).save();
    await this.vault.save(session); // encrypted at rest; the plaintext string never leaves this process
    this.accountLabel = await this.labelFor(c);
    this.pending = null;
    this.current = "connected";
    this.lastError = null;
    log("info", "telegram_login_completed");
  }

  async logout(): Promise<TelegramServiceStatus> {
    try {
      // Revokes the session on Telegram's side too (it disappears from Settings → Devices).
      if (this.client && this.current === "connected") await this.client.invoke(new Api.auth.LogOut());
    } catch (err) {
      log("warn", "telegram_logout_remote_failed", { error: mapTelegramError(err).code });
    }
    await this.client?.disconnect().catch(() => undefined);
    await this.client?.destroy().catch(() => undefined);
    this.client = null;
    this.pending = null;
    this.accountLabel = null;
    this.docs.delete("*");
    await this.vault.destroy();
    this.current = "disconnected";
    this.lastError = null;
    return this.status();
  }

  /* ───────────── channels & history ───────────── */

  private async peerFor(channel: string): Promise<Api.TypeEntityLike> {
    const c = this.requireClient();
    const ref = normalizeChannelRef(channel);
    try {
      if (ref.kind === "username") return (await this.api.run(() => c.getEntity(ref.username))) as Api.TypeEntityLike;
      const id = bigInt(ref.id);
      try {
        return (await this.api.run(() => c.getEntity(id))) as Api.TypeEntityLike;
      } catch {
        // Entity cache is cold after a restart; loading dialogs repopulates access hashes.
        await this.api.run(() => c.getDialogs({ limit: 500 }));
        return (await this.api.run(() => c.getEntity(id))) as Api.TypeEntityLike;
      }
    } catch (err) {
      throw mapTelegramError(err);
    }
  }

  async resolveChannel(channel: string): Promise<ResolvedChannel> {
    const c = this.requireClient();
    const entity = (await this.peerFor(channel)) as Api.Channel;
    if (entity.className !== "Channel") throw new ServiceError(400, "not_a_channel", "That ID is not a channel or supergroup.");
    try {
      await this.api.run(() => c.getMessages(entity, { limit: 1 })); // proves read access
    } catch (err) {
      throw mapTelegramError(err);
    }
    return { telegramChannelId: getPeerId(entity), title: entity.title, username: entity.username ?? null };
  }

  async historyPage(channel: string, offsetId: number, floorId: number, limit: number): Promise<HistoryPageResponse> {
    const c = this.requireClient();
    const peer = await this.peerFor(channel);
    try {
      const msgs = await this.api.run(() =>
        c.getMessages(peer, { limit, offsetId, minId: floorId, filter: new Api.InputMessagesFilterVideo() }),
      );
      const list = [...msgs].filter((m): m is AnyMsg => m.className === "Message");
      const videos = list.map((m) => extractVideo(m)).filter((v): v is NonNullable<typeof v> => v !== null);
      const lowest = list.length ? Math.min(...list.map((m) => m.id)) : null;
      return { videos, nextOffsetId: lowest, scanned: list.length, done: list.length < limit };
    } catch (err) {
      throw mapTelegramError(err);
    }
  }

  async getMessages(channel: string, ids: number[]): Promise<{ items: MessageGetItem[] }> {
    const c = this.requireClient();
    const peer = await this.peerFor(channel);
    try {
      const msgs = await this.api.run(() => c.getMessages(peer, { ids }));
      const byId = new Map<number, AnyMsg>();
      for (const m of msgs) if (m && m.className === "Message") byId.set(m.id, m as AnyMsg);
      return { items: ids.map((id) => { const m = byId.get(id); return { messageId: id, exists: !!m, video: m ? extractVideo(m) : null }; }) };
    } catch (err) {
      throw mapTelegramError(err);
    }
  }

  /* ───────────── media ───────────── */

  /** Fetches (or reuses) the document for a message. `fresh` bypasses the cache — used when a file reference expired. */
  private async loadDoc(channel: string, messageId: number, fresh: boolean): Promise<DocEntry> {
    const key = `${channel}:${messageId}`;
    if (!fresh) {
      const hit = this.docs.get(key);
      if (hit) return hit;
    }
    const c = this.requireClient();
    const peer = await this.peerFor(channel);
    let msg: AnyMsg | undefined;
    try {
      const res = await this.api.run(() => c.getMessages(peer, { ids: [messageId] }));
      msg = res[0] as AnyMsg | undefined;
    } catch (err) {
      throw mapTelegramError(err);
    }
    const doc = msg && msg.className === "Message" ? getDocument(msg) : null;
    if (!msg || !doc || !isVideoDocument(doc)) {
      throw new ServiceError(410, "media_unavailable", "The message was deleted or no longer contains a video.");
    }
    const entry: DocEntry = {
      doc: doc as unknown as Api.Document,
      media: msg.media as Api.TypeMessageMedia,
      size: Number((doc as { size?: unknown }).size ?? 0),
      mimeType: (doc.mimeType ?? "video/mp4").toLowerCase(),
    };
    this.docs.set(key, entry);
    return entry;
  }

  async getMediaSource(channel: string, messageId: number): Promise<MediaSource> {
    const entry = await this.loadDoc(channel, messageId, false);
    const key = `${channel}:${messageId}`;
    const c = this.requireClient();
    const load = (fresh: boolean) => this.loadDoc(channel, messageId, fresh);
    const size = entry.size;

    return {
      size,
      mimeType: entry.mimeType,
      async *read(start: number, end: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
        let doc = entry.doc;
        let pos = start;
        let refreshes = 0;
        while (pos <= end) {
          if (signal.aborted) return;
          // MTProto needs 4 KiB-aligned offsets and requests that don't cross a 1 MiB boundary.
          const aligned = pos - (pos % REQUEST_SIZE);
          const chunks = Math.ceil((end + 1 - aligned) / REQUEST_SIZE);
          const iter = c.iterDownload({
            file: fileLocationOf(doc),
            dcId: doc.dcId, // the file may live on another datacenter than the client's home DC
            offset: bigInt(aligned),
            limit: chunks,
            requestSize: REQUEST_SIZE,
            fileSize: bigInt(size),
          });
          try {
            let offset = aligned;
            const it = iter[Symbol.asyncIterator]();
            // Read-ahead: while chunk N is being sent to the viewer, chunk N+1 is already coming from Telegram.
            // Without this each 512 KiB chunk costs a full Telegram round-trip, which is too slow for 4K bitrates.
            // (Only one request is ever in flight per stream, and next() is never called concurrently.)
            let pending: Promise<IteratorResult<Uint8Array>> = it.next();
            for (;;) {
              const r = await pending;
              if (r.done) break;
              const buf = r.value;
              if (signal.aborted) return;
              const chunkStart = offset;
              offset += buf.length;
              if (offset <= end) {
                pending = it.next();
                pending.catch(() => undefined); // a failure is surfaced by the await above, never as an unhandled rejection
              } else {
                pending = Promise.resolve({ done: true, value: undefined } as IteratorReturnResult<undefined>);
              }
              const from = Math.max(pos, chunkStart);
              const to = Math.min(end, chunkStart + buf.length - 1);
              if (from <= to) {
                yield buf.subarray(from - chunkStart, to - chunkStart + 1);
                pos = to + 1;
              }
              if (pos > end) return;
            }
            if (pos <= end) throw new ServiceError(502, "short_read", "Telegram ended the download early.");
            return;
          } catch (err) {
            const mapped = mapTelegramError(err);
            if (mapped.code === "file_reference_expired" && refreshes < 2) {
              // File references are not permanent. Re-fetch the message for a fresh reference and
              // resume from the first byte not yet delivered — the viewer notices nothing.
              refreshes++;
              log("info", "file_reference_refreshed", { attempt: refreshes });
              doc = (await load(true)).doc;
              continue;
            }
            throw mapped;
          } finally {
            await iter.close().catch(() => undefined);
          }
        }
        void key;
      },
    };
  }

  async getThumbnail(channel: string, messageId: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const key = `${channel}:${messageId}`;
    const cached = this.thumbs.get(key);
    if (cached) return { bytes: cached, mimeType: "image/jpeg" };
    const entry = await this.loadDoc(channel, messageId, false);
    const thumbs = (entry.doc.thumbs ?? []) as Api.TypePhotoSize[];
    const usable = thumbs.filter((t) => ["PhotoSize", "PhotoCachedSize", "PhotoStrippedSize"].includes(t.className));
    const best = usable[usable.length - 1];
    if (!best) throw new ServiceError(404, "no_thumbnail", "This video has no thumbnail.");
    try {
      const c = this.requireClient();
      const data = await this.api.run(() => c.downloadMedia(entry.media, { thumb: best }));
      if (!data || typeof data === "string") throw new ServiceError(404, "no_thumbnail", "This video has no thumbnail.");
      const bytes = new Uint8Array(data);
      this.thumbs.set(key, bytes);
      return { bytes, mimeType: "image/jpeg" };
    } catch (err) {
      throw mapTelegramError(err);
    }
  }
}
