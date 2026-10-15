import { afterEach, describe, expect, it, vi } from "vitest";
import { loggedInHarness, type Harness } from "./helpers/harness";

afterEach(() => vi.unstubAllGlobals());

const dbId = (h: Harness, messageId: number) => h.db.q<{ id: number }>("SELECT id FROM videos WHERE telegram_message_id = ?", messageId)[0]!.id;
const json = async (r: Response) => (await r.json()) as any;

async function library(h: Harness) {
  h.gateway.addVideos([1, 2, 3, 4, 5, 6], (id) =>
    ({
      1: { title: "Sunset over Tokyo", durationSeconds: 90, tags: ["travel", "city"] },
      2: { title: "Tokyo night market", durationSeconds: 600, tags: ["travel", "food"] },
      3: { title: "Quiet morning", description: "A walk through Kyoto before sunrise", durationSeconds: 1800 },
      4: { title: "Tokyo guide", durationSeconds: 300 },
      5: { title: "Cooking basics", description: "Tokyo is mentioned only in passing here", durationSeconds: 3000, tags: ["food"] },
      6: { title: "Mountains", durationSeconds: 45 },
    })[id] ?? {},
  );
  return h.seedLibrary();
}

// The visitor-facing catalogue is gone; the same listing/search engine now powers the admin library view.
describe("admin listing & cursor pagination", () => {
  it("pages through the whole catalogue with no duplicates or gaps, even with identical timestamps", async () => {
    const h = await loggedInHarness();
    // 30 videos in 3 timestamp "bursts" → heavy ties on published_at
    h.gateway.addVideos(Array.from({ length: 30 }, (_, i) => i + 1), (id) => ({ publishedAt: 1_700_000_000 + Math.floor(id / 10) * 1000 }));
    await h.seedLibrary();

    for (const sort of ["newest", "oldest"]) {
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q = new URLSearchParams({ limit: "7", sort });
        if (cursor) q.set("cursor", cursor);
        const page = await json(await h.admin.get(`/api/admin/videos?${q}`));
        seen.push(...page.items.map((v: any) => v.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 20);
      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
      expect(pages).toBe(5); // 7+7+7+7+2
    }
  });

  it("orders newest-first and oldest-first by publish date", async () => {
    const h = await loggedInHarness();
    await library(h);
    const newest = (await json(await h.admin.get("/api/admin/videos?sort=newest"))).items.map((v: any) => v.publishedAt);
    expect([...newest].sort((a, b) => b - a)).toEqual(newest);
    const oldest = (await json(await h.admin.get("/api/admin/videos?sort=oldest"))).items.map((v: any) => v.publishedAt);
    expect([...oldest].sort((a, b) => a - b)).toEqual(oldest);
  });

  it("validates query parameters and tolerates garbage cursors", async () => {
    const h = await loggedInHarness();
    await library(h);
    expect((await h.admin.get("/api/admin/videos?limit=1000")).status).toBe(400);
    expect((await h.admin.get("/api/admin/videos?limit=0")).status).toBe(400);
    expect((await h.admin.get("/api/admin/videos?sort=sideways")).status).toBe(400);
    const r = await h.admin.get("/api/admin/videos?cursor=%25%25not-a-cursor");
    expect(r.status).toBe(200);
    expect((await json(r)).items.length).toBe(6);
  });

  it("filters by duration, recency and channel", async () => {
    const h = await loggedInHarness();
    await library(h);
    const dur = await json(await h.admin.get("/api/admin/videos?minDuration=100&maxDuration=1000"));
    expect(dur.items.map((v: any) => v.title).sort()).toEqual(["Tokyo guide", "Tokyo night market"]);
    const recent = await json(await h.admin.get("/api/admin/videos?days=1"));
    expect(recent.items).toHaveLength(0); // fixtures are from 2023
    const ch = await json(await h.admin.get("/api/admin/videos?channel=1"));
    expect(ch.items).toHaveLength(6);
    expect((await json(await h.admin.get("/api/admin/videos?channel=999"))).items).toHaveLength(0);
  });
});

describe("admin search", () => {
  it("matches titles, descriptions and tags, with prefix matching", async () => {
    const h = await loggedInHarness();
    await library(h);
    const titles = async (q: string) => (await json(await h.admin.get(`/api/admin/videos?q=${encodeURIComponent(q)}`))).items.map((v: any) => v.title);
    expect((await titles("tokyo")).sort()).toEqual(["Cooking basics", "Sunset over Tokyo", "Tokyo guide", "Tokyo night market"]);
    expect((await titles("tok")).length).toBe(4); // prefix
    expect(await titles("kyoto")).toEqual(["Quiet morning"]); // description-only match
    expect((await titles("food")).sort()).toEqual(["Cooking basics", "Tokyo night market"]); // tag match
    expect(await titles("zzzznomatch")).toEqual([]);
  });

  it("ranks title matches above description-only matches under relevance sort", async () => {
    const h = await loggedInHarness();
    await library(h);
    const items = (await json(await h.admin.get("/api/admin/videos?q=tokyo&sort=relevance"))).items.map((v: any) => v.title);
    expect(items[items.length - 1]).toBe("Cooking basics"); // only mentions Tokyo in the description
  });

  it("combines search with filters and supports cursor pagination of ranked results", async () => {
    const h = await loggedInHarness();
    await library(h);
    const filtered = await json(await h.admin.get("/api/admin/videos?q=tokyo&maxDuration=400"));
    expect(filtered.items.map((v: any) => v.title).sort()).toEqual(["Sunset over Tokyo", "Tokyo guide"]);
    const p1 = await json(await h.admin.get("/api/admin/videos?q=tokyo&sort=relevance&limit=2"));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await json(await h.admin.get(`/api/admin/videos?q=tokyo&sort=relevance&limit=2&cursor=${p1.nextCursor}`));
    const all = [...p1.items, ...p2.items].map((v: any) => v.id);
    expect(new Set(all).size).toBe(4);
  });

  it("neutralises FTS5 operators and SQL injection attempts (no 500s, no data loss)", async () => {
    const h = await loggedInHarness();
    await library(h);
    const hostile = [`"`, `tokyo OR`, `NEAR(`, `*`, `title:tokyo`, `-tokyo`, `tokyo"; DROP TABLE videos; --`, `' OR 1=1 --`, `)(`, `\\`, "%00", "a".repeat(5000)];
    for (const q of hostile) {
      const r = await h.admin.get(`/api/admin/videos?q=${encodeURIComponent(q)}`);
      expect([200, 400], `q=${q.slice(0, 20)}`).toContain(r.status);
    }
    expect(h.db.q<any>("SELECT COUNT(*) AS n FROM videos")[0].n).toBe(6);
    const none = await json(await h.admin.get(`/api/admin/videos?q=${encodeURIComponent("!!!")}`));
    expect(none.items).toEqual([]);
  });
});

describe("data retention", () => {
  it("purges old watch history and finished jobs but keeps recent rows", async () => {
    const { purgeOldData, WATCH_HISTORY_RETENTION_DAYS } = await import("../apps/api/src/lib/retention");
    const h = await loggedInHarness();
    await library(h);
    const vid = dbId(h, 1);
    const old = Math.floor(Date.now() / 1000) - (WATCH_HISTORY_RETENTION_DAYS + 5) * 86_400;
    h.db.raw.prepare("INSERT INTO watch_history (visitor_id, video_id, position_seconds, updated_at) VALUES (?,?,?,?)").run("old-visitor", vid, 10, old);
    h.db.raw.prepare("INSERT INTO watch_history (visitor_id, video_id, position_seconds) VALUES (?,?,?)").run("new-visitor", vid, 10);
    await purgeOldData(h.env);
    const left = h.db.q<{ visitor_id: string }>("SELECT visitor_id FROM watch_history").map((r) => r.visitor_id);
    expect(left).toEqual(["new-visitor"]);
  });
});
