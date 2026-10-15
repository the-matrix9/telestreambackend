import type { HistoryPageResponse, IndexedVideo, ResolvedChannel, TelegramServiceStatus, TelegramStatus } from "@telestream/shared";
import { ServiceError } from "../../apps/telegram-service/src/errors";
import type { MessageGetItem, TelegramGateway } from "../../apps/telegram-service/src/gateway";
import type { MediaSource } from "../../apps/telegram-service/src/streaming";

export interface FakeMessage {
  id: number;
  video: IndexedVideo | null; // null → non-video message (never returned by the video-filtered history)
  deleted?: boolean;
  bytes?: Uint8Array;
}

export const CHANNEL_ID = "-1001234567890";
export const SECRET_CODE = "12345";
export const SECRET_2FA = "correct horse";

export function makeVideo(id: number, over: Partial<IndexedVideo> = {}): IndexedVideo {
  return {
    messageId: id,
    title: `Video ${id}`,
    description: "",
    tags: [],
    durationSeconds: 120,
    fileSizeBytes: 4000,
    mimeType: "video/mp4",
    width: 1280,
    height: 720,
    hasThumbnail: true,
    publishedAt: 1_700_000_000 + id * 60,
    supported: true,
    ...over,
  };
}

export function bytesFor(id: number, size = 4000): Uint8Array {
  return new Uint8Array(size).map((_, i) => (i * 31 + id) % 256);
}

/** In-memory Telegram: one channel, scriptable failures, and a real login state machine. */
export class FakeGateway implements TelegramGateway {
  messages: FakeMessage[] = [];
  current: TelegramStatus = "disconnected";
  twoFactor = true;
  failHistory: { remaining: number; status: number; code: string } | null = null;
  historyCalls = 0;
  loginSecretsSeen: string[] = []; // lets tests prove secrets never leak out of the service boundary

  addVideos(ids: number[], over: (id: number) => Partial<IndexedVideo> = () => ({})): void {
    for (const id of ids) this.messages.push({ id, video: makeVideo(id, over(id)), bytes: bytesFor(id) });
  }

  state(): TelegramStatus { return this.current; }
  status(): TelegramServiceStatus {
    return { status: this.current, accountLabel: this.current === "connected" ? "@tester" : null, hint: this.current };
  }

  async requestCode(phone: string): Promise<TelegramServiceStatus> {
    this.loginSecretsSeen.push(phone);
    if (this.current === "connected") throw new ServiceError(409, "already_connected", "Already connected.");
    this.current = "awaiting_code";
    return this.status();
  }
  async verifyCode(code: string): Promise<TelegramServiceStatus> {
    if (this.current !== "awaiting_code") throw new ServiceError(409, "wrong_state", "Not waiting for a code.");
    if (code !== SECRET_CODE) throw new ServiceError(400, "code_invalid", "That login code is incorrect.");
    this.current = this.twoFactor ? "awaiting_password" : "connected";
    return this.status();
  }
  async verifyPassword(password: string): Promise<TelegramServiceStatus> {
    if (this.current !== "awaiting_password") throw new ServiceError(409, "wrong_state", "Not waiting for a password.");
    if (password !== SECRET_2FA) throw new ServiceError(400, "password_invalid", "The two-step verification password is incorrect.");
    this.current = "connected";
    return this.status();
  }
  async logout(): Promise<TelegramServiceStatus> { this.current = "disconnected"; return this.status(); }

  private requireConnected(): void {
    if (this.current !== "connected") throw new ServiceError(503, "not_connected", "No Telegram account is connected yet.");
  }
  private checkChannel(channel: string): void {
    if (channel !== CHANNEL_ID && channel !== "@mychannel") throw new ServiceError(403, "channel_inaccessible", "This account cannot access that channel.");
  }

  async resolveChannel(channel: string): Promise<ResolvedChannel> {
    this.requireConnected();
    this.checkChannel(channel);
    return { telegramChannelId: CHANNEL_ID, title: "Test Channel", username: "mychannel" };
  }

  async historyPage(channel: string, offsetId: number, floorId: number, limit: number): Promise<HistoryPageResponse> {
    this.requireConnected();
    this.checkChannel(channel);
    this.historyCalls++;
    if (this.failHistory && this.failHistory.remaining > 0) {
      this.failHistory.remaining--;
      throw new ServiceError(this.failHistory.status, this.failHistory.code, "Telegram is temporarily unreachable.", 1);
    }
    const page = this.messages
      .filter((m) => m.video && !m.deleted && (offsetId === 0 || m.id < offsetId) && m.id > floorId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return {
      videos: page.map((m) => m.video!),
      nextOffsetId: page.length ? page[page.length - 1]!.id : null,
      scanned: page.length,
      done: page.length < limit,
    };
  }

  async getMessages(channel: string, ids: number[]): Promise<{ items: MessageGetItem[] }> {
    this.requireConnected();
    this.checkChannel(channel);
    return {
      items: ids.map((id) => {
        const m = this.messages.find((x) => x.id === id && !x.deleted);
        return { messageId: id, exists: !!m, video: m?.video ?? null };
      }),
    };
  }

  async getMediaSource(channel: string, messageId: number): Promise<MediaSource> {
    this.requireConnected();
    this.checkChannel(channel);
    const m = this.messages.find((x) => x.id === messageId);
    if (!m || m.deleted || !m.video || !m.bytes) throw new ServiceError(410, "media_unavailable", "The message was deleted or no longer contains a video.");
    const bytes = m.bytes;
    return {
      size: bytes.length,
      mimeType: m.video.mimeType,
      async *read(start, end, signal) {
        for (let pos = start; pos <= end && !signal.aborted; pos += 1000) {
          yield bytes.slice(pos, Math.min(end, pos + 999) + 1);
        }
      },
    };
  }

  async getThumbnail(channel: string, messageId: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
    this.requireConnected();
    this.checkChannel(channel);
    const m = this.messages.find((x) => x.id === messageId);
    if (!m?.video?.hasThumbnail) throw new ServiceError(404, "no_thumbnail", "This video has no thumbnail.");
    return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg" };
  }
}
