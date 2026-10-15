import { signPlaybackToken } from "@telestream/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_STREAMS_PER_IP } from "../apps/api/src/routes/public";
import { bytesFor } from "./helpers/fake-gateway";
import { loggedInHarness, ORIGIN, type Harness } from "./helpers/harness";

afterEach(() => vi.unstubAllGlobals());

const dbId = (h: Harness, messageId: number) => h.db.q<{ id: number }>("SELECT id FROM videos WHERE telegram_message_id = ?", messageId)[0]!.id;
const pubId = (h: Harness, messageId: number) => h.db.q<{ public_id: string }>("SELECT public_id FROM videos WHERE telegram_message_id = ?", messageId)[0]!.public_id;
const buf = async (r: Response) => new Uint8Array(await r.arrayBuffer());

async function setup() {
  const h = await loggedInHarness();
  h.gateway.addVideos([1, 2, 3]);
  await h.seedLibrary();
  /** Same as the browser: ask /api/play for the stream URL, then request it (path + query only, the test host is virtual). */
  const urlFor = async (msg: number) => {
    const res = await h.req(`/api/play/${pubId(h, msg)}`);
    const u = new URL(((await res.json()) as any).streamUrl as string);
    return u.pathname + u.search;
  };
  return { h, urlFor };
}

describe("playback authorisation", () => {
  it("refuses requests with no, malformed, tampered, expired or wrong-video tokens", async () => {
    const { h, urlFor } = await setup();
    const id = dbId(h, 1);
    const pid = pubId(h, 1);
    const good = await urlFor(1);
    const token = new URL(good, "https://x").searchParams.get("t")!;

    expect((await h.req(`/api/stream/${pid}`)).status).toBe(403);
    expect((await h.req(`/api/stream/${pid}?t=garbage`)).status).toBe(403);
    expect((await h.req(`/api/stream/${pid}?t=${token.slice(0, -2)}xx`)).status).toBe(403); // tampered signature
    const expired = await signPlaybackToken(h.env.PLAYBACK_SECRET, { vid: id, exp: Math.floor(Date.now() / 1000) - 5 });
    const r = await h.req(`/api/stream/${pid}?t=${expired}`);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe("invalid_playback_token");
    const forged = await signPlaybackToken("a-different-secret", { vid: id, exp: Math.floor(Date.now() / 1000) + 600 });
    expect((await h.req(`/api/stream/${pid}?t=${forged}`)).status).toBe(403);
    // a valid token for video A cannot be used to read video B
    expect((await h.req(`/api/stream/${pubId(h, 2)}?t=${token}`)).status).toBe(403);
    // unknown or malformed ids are indistinguishable from a bad token (no way to probe which ids exist)
    expect((await h.req(`/api/stream/${"0".repeat(24)}?t=${token}`)).status).toBe(403);
    expect((await h.req(`/api/stream/${id}?t=${token}`)).status).toBe(403); // the numeric database id is not an address
  });

  it("is not an open proxy: query parameters cannot redirect it to other channels/messages/URLs", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(1);
    const r = await h.req(`${url}&channel=-1009999999999&message=3&url=http://169.254.169.254/latest/meta-data`);
    expect(r.status).toBe(200);
    expect(await buf(r)).toEqual(bytesFor(1)); // still video 1, byte-for-byte
  });
});

describe("HTTP Range semantics", () => {
  it("serves a full 200 response with correct headers and no public caching", async () => {
    const { h, urlFor } = await setup();
    const r = await h.req(await urlFor(1));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe("4000");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await buf(r)).toEqual(bytesFor(1));
  });

  it("serves 206 Partial Content with a correct Content-Range for seeks", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(2);
    for (const [range, start, end] of [["bytes=0-0", 0, 0], ["bytes=100-1499", 100, 1499], ["bytes=3999-", 3999, 3999], ["bytes=-10", 3990, 3999], ["bytes=2500-99999", 2500, 3999]] as const) {
      const r = await h.req(url, { headers: { range } });
      expect(r.status, range).toBe(206);
      expect(r.headers.get("content-range"), range).toBe(`bytes ${start}-${end}/4000`);
      expect(r.headers.get("content-length"), range).toBe(String(end - start + 1));
      expect(await buf(r), range).toEqual(bytesFor(2).slice(start, end + 1));
    }
  });

  it("returns 416 Range Not Satisfiable with Content-Range: bytes */size", async () => {
    const { h, urlFor } = await setup();
    const r = await h.req(await urlFor(1), { headers: { range: "bytes=4000-" } });
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */4000");
  });

  it("answers HEAD with headers only", async () => {
    const { h, urlFor } = await setup();
    const r = await h.req(await urlFor(1), { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("4000");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });

  it("ignores a malformed Range header (serves 200) rather than failing", async () => {
    const { h, urlFor } = await setup();
    expect((await h.req(await urlFor(1), { headers: { range: "bytes=oops" } })).status).toBe(200);
  });

  it("simulates a player seeking back and forth and always gets the right bytes", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(3);
    const expected = bytesFor(3);
    for (const start of [0, 3500, 1200, 2999, 40, 3999, 1]) {
      const r = await h.req(url, { headers: { range: `bytes=${start}-` } });
      expect(await buf(r)).toEqual(expected.slice(start));
    }
  });
});

describe("concurrency, cancellation and failure modes", () => {
  it("serves many concurrent viewers correctly", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(1);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => h.req(url, { ip: `198.51.100.${i}`, headers: { range: `bytes=${i * 100}-${i * 100 + 99}` } }).then(async (r) => ({ i, status: r.status, body: await buf(r) }))),
    );
    for (const { i, status, body } of results) {
      expect(status).toBe(206);
      expect(body).toEqual(bytesFor(1).slice(i * 100, i * 100 + 100));
    }
  });

  it("caps simultaneous streams per client and frees capacity when a viewer disconnects", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(1);
    const open: Response[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_IP; i++) {
      const r = await h.req(url, { ip: "192.0.2.99" });
      expect(r.status).toBe(200);
      open.push(r); // bodies intentionally left unread = streams still open
    }
    const blocked = await h.req(url, { ip: "192.0.2.99" });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as any).error.code).toBe("too_many_streams");
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    // someone else is unaffected
    expect((await h.req(url, { ip: "192.0.2.100", headers: { range: "bytes=0-9" } })).status).toBe(206);

    await open[0]!.body!.cancel(); // viewer closes the tab
    await new Promise((r) => setTimeout(r, 20));
    const again = await h.req(url, { ip: "192.0.2.99", headers: { range: "bytes=0-9" } });
    expect(again.status).toBe(206);
    await Promise.all(open.slice(1).map((r) => r.body!.cancel()));
  });

  it("releases the upstream stream slot when the viewer cancels", async () => {
    const { h, urlFor } = await setup();
    const r = await h.req(await urlFor(1));
    expect(h.slots.inUse).toBe(1);
    await r.body!.cancel();
    await new Promise((res) => setTimeout(res, 20));
    expect(h.slots.inUse).toBe(0);
  });

  it("reports deleted media as unavailable (404), marks it, and removes it from the catalogue", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(2);
    h.gateway.messages.find((m) => m.id === 2)!.deleted = true; // removed in Telegram after indexing
    const r = await h.req(url);
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.code).toBe("video_unavailable");
    await h.flush();
    expect(h.db.q<any>("SELECT availability_status AS s FROM videos WHERE telegram_message_id = 2")[0].s).toBe("unavailable");
    expect((await h.req(`/api/play/${pubId(h, 2)}`)).status).toBe(404);
  });

  it("returns a clear 502 when the Telegram service is unreachable", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(1);
    h.serviceDown.v = true;
    const r = await h.req(url);
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.code).toBe("telegram_service_unreachable");
  });

  it("returns 502 (not a crash) when the Telegram account got disconnected", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(1);
    h.gateway.current = "error";
    const r = await h.req(url);
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.code).toBe("not_connected");
  });

  it("does not leak the service secret or Telegram identifiers in stream responses", async () => {
    const { h, urlFor } = await setup();
    const r = await h.req(await urlFor(1), { headers: { range: "bytes=0-9" } });
    const all = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(all).not.toMatch(/x-ts-|signature|1001234567890|telegram/i);
  });
});

describe("player-only guards", () => {
  it("refuses the stream link when it is opened as a page or embedded, but serves media elements", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(1);
    for (const dest of ["document", "iframe", "embed", "object"]) {
      const r = await h.req(url, { headers: { "sec-fetch-dest": dest } });
      expect(r.status, dest).toBe(403);
      expect(((await r.json()) as any).error.code).toBe("playback_only");
    }
    const ok = await h.req(url, { headers: { "sec-fetch-dest": "video", range: "bytes=0-9" } });
    expect(ok.status).toBe(206);
  });

  it("refuses hot-linking from other sites but allows the configured frontend and header-less clients", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(1);
    expect((await h.req(url, { headers: { referer: "https://evil.example/watch" } })).status).toBe(403);
    expect((await h.req(url, { headers: { referer: "not a url" } })).status).toBe(403);
    expect((await h.req(url, { headers: { referer: `${ORIGIN}/v/${pubId(h, 1)}`, range: "bytes=0-9" } })).status).toBe(206);
    expect((await h.req(url, { headers: { range: "bytes=0-9" } })).status).toBe(206);
  });

  it("allows the stream cross-origin (the player is on another origin) and never sets cookies", async () => {
    const { h, urlFor } = await setup();
    const r = await h.req(await urlFor(1), { headers: { range: "bytes=0-9" } });
    expect(r.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect(r.headers.get("set-cookie")).toBeNull();
  });
});

describe("thumbnails are admin-only", () => {
  it("serves thumbnails to a signed-in admin, never to visitors, and 404s when there is none", async () => {
    const { h } = await setup();
    const id = dbId(h, 1);
    expect((await h.req(`/api/videos/${id}/thumbnail`)).status).toBe(404); // the old public route is gone
    const anon = await h.req(`/api/admin/videos/${id}/thumbnail`);
    expect(anon.status).toBe(401);

    const r = await h.admin.get(`/api/admin/videos/${id}/thumbnail`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("cache-control")).toMatch(/private/);
    expect((await buf(r)).length).toBe(4);

    h.gateway.messages.find((m) => m.id === 2)!.video!.hasThumbnail = false;
    expect((await h.admin.get(`/api/admin/videos/${dbId(h, 2)}/thumbnail`)).status).toBe(404);
    expect((await h.admin.get("/api/admin/videos/99999/thumbnail")).status).toBe(404);
    expect((await h.admin.get("/api/admin/videos/abc/thumbnail")).status).toBe(404);
  });
});

describe("service-to-service signing", () => {
  it("rejects the API when the shared secret is wrong (misconfiguration is reported, not hidden)", async () => {
    const { h, urlFor } = await setup();
    const url = await urlFor(1);
    h.env.TG_SERVICE_SECRET = "z".repeat(48);
    const r = await h.req(url);
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.code).toBe("telegram_service_auth");
  });
});
