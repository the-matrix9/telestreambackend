import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_PLAYBACK_TTL_SECONDS, UNKNOWN_DURATION_TTL_SECONDS, playbackTtlSeconds } from "../apps/api/src/routes/public";
import { loggedInHarness, type Harness } from "./helpers/harness";

afterEach(() => vi.unstubAllGlobals());

const json = async (r: Response) => (await r.json()) as any;
const pubId = (h: Harness, messageId: number) => h.db.q<{ public_id: string }>("SELECT public_id FROM videos WHERE telegram_message_id = ?", messageId)[0]!.public_id;

async function library(durations: Record<number, number> = {}) {
  const h = await loggedInHarness();
  h.gateway.addVideos([1, 2, 3, 4], (id) => ({ title: `Secret title ${id}`, description: `Secret description ${id}`, tags: ["private"], durationSeconds: durations[id] ?? 90 }));
  await h.seedLibrary();
  return h;
}

describe("stream-link lifetime = 2x the video length", () => {
  it("computes the lifetime with a floor and a fallback", () => {
    expect(playbackTtlSeconds(90)).toBe(180);
    expect(playbackTtlSeconds(3600)).toBe(7200);
    expect(playbackTtlSeconds(10)).toBe(MIN_PLAYBACK_TTL_SECONDS);
    expect(playbackTtlSeconds(0)).toBe(UNKNOWN_DURATION_TTL_SECONDS);
    expect(playbackTtlSeconds(Number.NaN)).toBe(UNKNOWN_DURATION_TTL_SECONDS);
  });

  it("issues links that expire after twice each video's duration", async () => {
    const h = await library({ 1: 90, 2: 600, 3: 7200, 4: 20 });
    const now = Math.floor(Date.now() / 1000);
    for (const [msg, ttl] of [[1, 180], [2, 1200], [3, 14400], [4, MIN_PLAYBACK_TTL_SECONDS]] as const) {
      const body = await json(await h.req(`/api/play/${pubId(h, msg)}`));
      expect(Math.abs(body.expiresAt - now - ttl), `video ${msg}`).toBeLessThanOrEqual(3);
    }
  });

  it("stops serving bytes once the link has expired", async () => {
    const h = await library({ 1: 60 });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const body = await json(await h.req(`/api/play/${pubId(h, 1)}`));
      const url = new URL(body.streamUrl);
      const path = url.pathname + url.search;
      expect((await h.req(path, { headers: { range: "bytes=0-9" } })).status).toBe(206);
      vi.setSystemTime(Date.now() + (MIN_PLAYBACK_TTL_SECONDS + 5) * 1000);
      const late = await h.req(path, { headers: { range: "bytes=0-9" } });
      expect(late.status).toBe(403);
      expect((await json(late)).error.code).toBe("invalid_playback_token");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the public API reveals nothing about the library", () => {
  it("returns only a stream URL, an expiry and the duration, with an unguessable id in the path", async () => {
    const h = await library();
    const r = await h.req(`/api/play/${pubId(h, 1)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const body = await json(r);
    expect(Object.keys(body).sort()).toEqual(["durationSeconds", "expiresAt", "streamUrl"]);
    expect(body.streamUrl).toMatch(new RegExp(`^https://api\\.telestream\\.test/api/stream/${pubId(h, 1)}\\?t=`));
    expect(JSON.stringify(body)).not.toMatch(/secret|title|description|private|telegram|1001234567890|message/i);
  });

  it("gives every video a distinct 96-bit hex id, including videos added by later syncs", async () => {
    const h = await library();
    const first = h.db.q<{ public_id: string }>("SELECT public_id FROM videos").map((r) => r.public_id);
    h.gateway.addVideos([5, 6]);
    const ch = h.db.q<{ id: number }>("SELECT id FROM channels")[0]!.id;
    await h.admin.post(`/api/admin/channels/${ch}/sync`, { confirm: true, mode: "incremental" });
    await h.flush();
    await h.drainJobs();
    const all = h.db.q<{ public_id: string }>("SELECT public_id FROM videos").map((r) => r.public_id);
    expect(all).toHaveLength(6);
    expect(first.every((id) => all.includes(id))).toBe(true); // existing ids are stable
    expect(new Set(all).size).toBe(6);
    for (const id of all) expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("404s for malformed, numeric, unknown, unsupported and removed videos", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2], (id) => (id === 2 ? { supported: false, mimeType: "video/x-matroska" } : {}));
    await h.seedLibrary();
    for (const id of ["1", "abc", "0".repeat(24), "G".repeat(24), pubId(h, 1).slice(0, 23) + "G", pubId(h, 1) + "0", pubId(h, 2)]) {
      expect((await h.req(`/api/play/${id}`)).status, id).toBe(404);
    }
    expect((await h.req(`/api/play/${pubId(h, 1)}`)).status).toBe(200);
  });

  it("no longer exposes listings, search, trending, channels, details, thumbnails or watch history", async () => {
    const h = await library();
    const paths = ["/api/videos", "/api/videos/1", "/api/videos/1/stream", "/api/videos/1/thumbnail", "/api/search?q=secret", "/api/trending", "/api/channels", "/api/continue-watching?visitorId=x"];
    for (const p of paths) expect((await h.req(p)).status, p).toBe(404);
    const post = await h.req("/api/watch-history", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(404);
  });

  it("rate-limits link minting per client", async () => {
    const h = await library();
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await h.req(`/api/play/${pubId(h, 1)}`, { ip: "192.0.2.50" })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    expect((await h.req(`/api/play/${pubId(h, 1)}`, { ip: "192.0.2.51" })).status).toBe(200);
  });
});

describe("admin sees the player link ids", () => {
  it("includes publicId in the admin video list only", async () => {
    const h = await library();
    const list = await json(await h.admin.get("/api/admin/videos"));
    expect(list.items.every((v: any) => /^[0-9a-f]{24}$/.test(v.publicId))).toBe(true);
    expect(list.items.map((v: any) => v.publicId).sort()).toEqual([1, 2, 3, 4].map((m) => pubId(h, m)).sort());
  });
});
