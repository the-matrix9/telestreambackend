import type { HistoryPageResponse, IndexedVideo, ResolvedChannel, TelegramServiceStatus, TelegramStatus } from "@telestream/shared";
import type { MediaSource } from "./streaming";

export interface MessageGetItem {
  messageId: number;
  exists: boolean;
  video: IndexedVideo | null;
}

/** Everything the HTTP layer needs from Telegram. The GramJS implementation lives in gramjs.ts only. */
export interface TelegramGateway {
  status(): TelegramServiceStatus;
  state(): TelegramStatus;
  requestCode(phone: string): Promise<TelegramServiceStatus>;
  verifyCode(code: string): Promise<TelegramServiceStatus>;
  verifyPassword(password: string): Promise<TelegramServiceStatus>;
  logout(): Promise<TelegramServiceStatus>;
  resolveChannel(channel: string): Promise<ResolvedChannel>;
  historyPage(channel: string, offsetId: number, floorId: number, limit: number): Promise<HistoryPageResponse>;
  getMessages(channel: string, ids: number[]): Promise<{ items: MessageGetItem[] }>;
  getMediaSource(channel: string, messageId: number): Promise<MediaSource>;
  getThumbnail(channel: string, messageId: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

/** "-1001234567890" stays; bare "1234567890" becomes "-1001234567890"; "@name"/"name" → "name". */
export function normalizeChannelRef(ref: string): { kind: "id"; id: string } | { kind: "username"; username: string } {
  const r = ref.trim();
  if (/^-?\d+$/.test(r)) {
    if (r.startsWith("-")) return { kind: "id", id: r };
    return { kind: "id", id: `-100${r}` };
  }
  return { kind: "username", username: r.replace(/^@/, "") };
}
