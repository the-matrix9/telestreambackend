import type { IndexedVideo } from "@telestream/shared";

/**
 * Pure extraction of indexable video metadata from a GramJS message. Uses `className` checks so it is
 * testable with plain objects and does not depend on class identity.
 */

/** MIME types browsers can play natively. Anything else is indexed as "unsupported" (see docs). */
export const BROWSER_PLAYABLE = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/ogg"]);

interface Attr { className: string; duration?: number; w?: number; h?: number; fileName?: string }
interface Doc { className: string; id?: unknown; mimeType?: string; size?: unknown; attributes?: Attr[]; thumbs?: unknown[]; videoThumbs?: unknown[] }
export interface MessageLike {
  id: number;
  className?: string;
  date?: number;
  message?: string;
  media?: { className: string; document?: Doc } | null;
}

const toNumber = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : v && typeof (v as { toString(): string }).toString === "function" ? Number((v as { toString(): string }).toString()) : 0);

export function getDocument(msg: MessageLike): Doc | null {
  if (!msg.media || msg.media.className !== "MessageMediaDocument") return null;
  const d = msg.media.document;
  return d && d.className === "Document" ? d : null;
}

export function isVideoDocument(doc: Doc | null): boolean {
  if (!doc) return false;
  if ((doc.mimeType ?? "").startsWith("video/")) return true;
  return (doc.attributes ?? []).some((a) => a.className === "DocumentAttributeVideo");
}

const TAG_RE = /#([\p{L}\p{N}_]{2,40})/gu;

export function parseCaption(caption: string, fileName: string | undefined, id: number): { title: string; description: string; tags: string[] } {
  const raw = (caption ?? "").replace(/\r/g, "").trim();
  const tags = [...new Set([...raw.matchAll(TAG_RE)].map((m) => m[1]!.toLowerCase()))].slice(0, 12);
  const stripTags = (s: string) => s.replace(TAG_RE, "").replace(/[ \t]{2,}/g, " ").trim();
  const lines = raw.split("\n").map((l) => l.trim());
  const firstIdx = lines.findIndex((l) => stripTags(l).length > 0);
  let title = firstIdx >= 0 ? stripTags(lines[firstIdx]!) : "";
  // Lines made only of hashtags are metadata (already captured in `tags`); inline hashtags stay readable.
  const tagOnly = (l: string) => l.length > 0 && stripTags(l).length === 0;
  let description = firstIdx >= 0 ? lines.slice(firstIdx + 1).filter((l) => !tagOnly(l)).join("\n").trim() : "";
  if (!title && fileName) title = fileName.replace(/\.[A-Za-z0-9]{2,5}$/, "").replace(/[_.]+/g, " ").trim();
  if (!title) title = `Video ${id}`;
  if (title.length > 120) {
    description = (title.slice(120) + (description ? "\n" + description : "")).trim();
    title = title.slice(0, 117).trimEnd() + "…";
  }
  return { title, description, tags };
}

/** Returns null when the message has no video document at all. */
export function extractVideo(msg: MessageLike): IndexedVideo | null {
  const doc = getDocument(msg);
  if (!doc || !isVideoDocument(doc)) return null;
  const videoAttr = (doc.attributes ?? []).find((a) => a.className === "DocumentAttributeVideo");
  const nameAttr = (doc.attributes ?? []).find((a) => a.className === "DocumentAttributeFilename");
  const mime = (doc.mimeType ?? "video/mp4").toLowerCase();
  const { title, description, tags } = parseCaption(msg.message ?? "", nameAttr?.fileName, msg.id);
  return {
    messageId: msg.id,
    title,
    description,
    tags,
    durationSeconds: Math.round(videoAttr?.duration ?? 0),
    fileSizeBytes: toNumber(doc.size),
    mimeType: mime,
    width: videoAttr?.w ?? null,
    height: videoAttr?.h ?? null,
    hasThumbnail: (doc.thumbs?.length ?? 0) > 0,
    publishedAt: msg.date ?? 0,
    supported: BROWSER_PLAYABLE.has(mime),
  };
}
