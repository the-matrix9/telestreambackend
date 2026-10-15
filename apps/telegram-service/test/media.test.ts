import { describe, expect, it } from "vitest";
import { normalizeChannelRef } from "../src/gateway";
import { extractVideo, parseCaption, type MessageLike } from "../src/media";
import { mapTelegramError } from "../src/errors";

const videoMsg = (over: Partial<MessageLike> = {}, mime = "video/mp4"): MessageLike => ({
  id: 42,
  date: 1_700_000_000,
  message: "Big Buck Bunny\nA short film about a rabbit.\n#animation #Blender",
  media: {
    className: "MessageMediaDocument",
    document: {
      className: "Document",
      mimeType: mime,
      size: BigInt(12_345_678),
      thumbs: [{}],
      attributes: [
        { className: "DocumentAttributeVideo", duration: 596.4, w: 1920, h: 1080 },
        { className: "DocumentAttributeFilename", fileName: "bbb_final.mp4" },
      ],
    },
  },
  ...over,
});

describe("extractVideo", () => {
  it("extracts title, description, tags and technical metadata", () => {
    const v = extractVideo(videoMsg())!;
    expect(v).toMatchObject({
      messageId: 42,
      title: "Big Buck Bunny",
      description: "A short film about a rabbit.\n#animation #Blender".replace(/#\w+/g, "").trim(),
      tags: ["animation", "blender"],
      durationSeconds: 596,
      fileSizeBytes: 12_345_678,
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
      hasThumbnail: true,
      publishedAt: 1_700_000_000,
      supported: true,
    });
  });

  it("falls back to the file name, then to a generic title", () => {
    expect(extractVideo(videoMsg({ message: "" }))!.title).toBe("bbb final");
    const noName = videoMsg({ message: "" });
    noName.media!.document!.attributes = [{ className: "DocumentAttributeVideo", duration: 5 }];
    expect(extractVideo(noName)!.title).toBe("Video 42");
  });

  it("flags formats browsers cannot play as unsupported instead of dropping them", () => {
    const mkv = extractVideo(videoMsg({}, "video/x-matroska"))!;
    expect(mkv.supported).toBe(false);
    expect(extractVideo(videoMsg({}, "video/webm"))!.supported).toBe(true);
  });

  it("returns null for non-video messages", () => {
    expect(extractVideo({ id: 1, message: "hello" })).toBeNull();
    expect(extractVideo({ id: 2, media: { className: "MessageMediaPhoto" } })).toBeNull();
    const pdf = videoMsg({}, "application/pdf");
    pdf.media!.document!.attributes = [];
    expect(extractVideo(pdf)).toBeNull();
  });
});

describe("parseCaption", () => {
  it("handles hashtag-only first lines and over-long titles", () => {
    expect(parseCaption("#a1 #b2\nReal title", undefined, 1).title).toBe("Real title");
    const long = parseCaption("x".repeat(200), undefined, 1);
    expect(long.title.length).toBeLessThanOrEqual(118);
    expect(long.description.length).toBeGreaterThan(0);
  });
});

describe("normalizeChannelRef", () => {
  it("normalises ids and usernames", () => {
    expect(normalizeChannelRef("-1001234567890")).toEqual({ kind: "id", id: "-1001234567890" });
    expect(normalizeChannelRef("1234567890")).toEqual({ kind: "id", id: "-1001234567890" });
    expect(normalizeChannelRef("@my_channel")).toEqual({ kind: "username", username: "my_channel" });
  });
});

describe("mapTelegramError", () => {
  it("maps flood waits to 429 with Retry-After", () => {
    const e = mapTelegramError({ errorMessage: "FLOOD_WAIT_42", seconds: 42 });
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(42);
  });
  it("gives clear login errors without leaking internals", () => {
    expect(mapTelegramError({ errorMessage: "PHONE_CODE_INVALID" }).code).toBe("code_invalid");
    expect(mapTelegramError({ errorMessage: "PASSWORD_HASH_INVALID" }).code).toBe("password_invalid");
    expect(mapTelegramError({ errorMessage: "SESSION_PASSWORD_NEEDED" }).code).toBe("password_required");
    expect(mapTelegramError({ errorMessage: "AUTH_KEY_UNREGISTERED" }).code).toBe("session_revoked");
    expect(mapTelegramError({ errorMessage: "CHANNEL_PRIVATE" }).code).toBe("channel_inaccessible");
    expect(mapTelegramError(new Error("boom: secret stack")).message).not.toContain("secret");
  });
});
