export type AvailabilityStatus = "available" | "unavailable" | "deleted" | "unsupported";
export type SyncStatus = "idle" | "pending" | "syncing" | "error";
export type JobType = "initial" | "incremental" | "resync" | "verify" | "reindex";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TelegramStatus =
  | "disconnected"
  | "awaiting_code"
  | "awaiting_password"
  | "connected"
  | "error";

/** Public video shape. Deliberately omits Telegram identifiers and file references. */
export interface VideoDTO {
  id: number;
  title: string;
  description: string;
  tags: string[];
  durationSeconds: number;
  fileSizeBytes: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
  publishedAt: number; // unix seconds
  channelId: number;
  channelTitle: string | null;
  progressSeconds?: number;
}

export interface VideoDetailDTO extends VideoDTO {
  playbackUrl: string;
  playbackExpiresAt: number;
  previousId: number | null;
  nextId: number | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** The only thing a visitor's browser ever learns about a video: where to stream it from, and until when. */
export interface PlayInfoDTO {
  streamUrl: string;
  expiresAt: number; // unix seconds
  durationSeconds: number;
}

export interface AdminVideoDTO extends VideoDTO {
  /** Opaque, unguessable id used in the public player link (/v/<publicId>). */
  publicId: string;
  telegramMessageId: number;
  availabilityStatus: AvailabilityStatus;
  indexedAt: number;
}

export interface ChannelDTO {
  id: number;
  telegramChannelId: string;
  title: string | null;
  username: string | null;
  syncStatus: SyncStatus;
  lastSyncedAt: number | null;
  importConfirmed: boolean;
  videoCount: number;
}

export interface SyncJobDTO {
  id: number;
  channelId: number;
  jobType: JobType;
  status: JobStatus;
  processedCount: number;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  attempts: number;
}

export interface AuditLogDTO {
  id: number;
  actor: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  createdAt: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** What the telegram-service returns for one indexed message. */
export interface IndexedVideo {
  messageId: number;
  title: string;
  description: string;
  tags: string[];
  durationSeconds: number;
  fileSizeBytes: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
  publishedAt: number;
  supported: boolean;
}

export interface HistoryPageResponse {
  videos: IndexedVideo[];
  /** lowest message id examined; pass as offsetId for the next page */
  nextOffsetId: number | null;
  scanned: number;
  done: boolean;
}

export interface MessageCheckItem {
  messageId: number;
  exists: boolean;
  isVideo: boolean;
  supported: boolean;
}

export interface TelegramServiceStatus {
  status: TelegramStatus;
  accountLabel: string | null;
  hint?: string;
  lastError?: string | null;
}

export interface ResolvedChannel {
  telegramChannelId: string;
  title: string;
  username: string | null;
}
