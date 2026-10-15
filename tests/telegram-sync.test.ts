import { afterEach, describe, expect, it, vi } from "vitest";
import { runSyncTick } from "../apps/api/src/lib/sync";
import { ServiceError } from "../apps/telegram-service/src/errors";
import { CHANNEL_ID, loggedInHarness, LOGIN } from "./helpers/harness";

afterEach(() => vi.unstubAllGlobals());

describe("Telegram login wizard", () => {
  it("walks phone → code → 2FA password → connected, and persists only an opaque reference", async () => {
    const h = await loggedInHarness();
    expect(((await (await h.admin.get("/api/admin/telegram/status")).json()) as any).status).toBe("disconnected");

    const r1 = await h.admin.post("/api/admin/telegram/login/request-code", { phone: "+14155550123" });
    expect(((await r1.json()) as any).status).toBe("awaiting_code");

    const r2 = await h.admin.post("/api/admin/telegram/login/verify-code", { code: LOGIN.SECRET_CODE });
    expect(((await r2.json()) as any).status).toBe("awaiting_password");

    const r3 = await h.admin.post("/api/admin/telegram/login/verify-password", { password: LOGIN.SECRET_2FA });
    const body = (await r3.json()) as any;
    expect(body.status).toBe("connected");
    expect(body.accountLabel).toBe("@tester");

    const acct = h.db.q<any>("SELECT * FROM telegram_accounts")[0];
    expect(acct.status).toBe("connected");
    expect(acct.encrypted_session_reference).toBe("vault:default"); // pointer only — no session string in D1
  });

  it("gives clear errors for a wrong code and a wrong 2FA password, without leaving the wizard", async () => {
    const h = await loggedInHarness();
    await h.admin.post("/api/admin/telegram/login/request-code", { phone: "+14155550123" });
    const bad = await h.admin.post("/api/admin/telegram/login/verify-code", { code: "00000" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("code_invalid");

    await h.admin.post("/api/admin/telegram/login/verify-code", { code: LOGIN.SECRET_CODE });
    const badPw = await h.admin.post("/api/admin/telegram/login/verify-password", { password: "nope" });
    expect(badPw.status).toBe(400);
    expect(((await badPw.json()) as any).error.code).toBe("password_invalid");
  });

  it("validates the phone number format before contacting Telegram", async () => {
    const h = await loggedInHarness();
    const r = await h.admin.post("/api/admin/telegram/login/request-code", { phone: "call me maybe" });
    expect(r.status).toBe(400);
    expect(h.gateway.loginSecretsSeen).toHaveLength(0);
  });

  it("never writes the phone number, login code or password to the audit log or any response", async () => {
    const h = await loggedInHarness();
    const responses: string[] = [];
    const grab = async (p: Promise<Response>) => { responses.push(await (await p).text()); };
    await grab(h.admin.post("/api/admin/telegram/login/request-code", { phone: "+14155550123" }));
    await grab(h.admin.post("/api/admin/telegram/login/verify-code", { code: LOGIN.SECRET_CODE }));
    await grab(h.admin.post("/api/admin/telegram/login/verify-password", { password: LOGIN.SECRET_2FA }));
    await grab(h.admin.get("/api/admin/telegram/status"));
    const dump = JSON.stringify(h.db.q("SELECT * FROM audit_log")) + JSON.stringify(h.db.q("SELECT * FROM telegram_accounts")) + responses.join("");
    for (const secret of ["4155550123", LOGIN.SECRET_CODE, LOGIN.SECRET_2FA]) expect(dump).not.toContain(secret);
    expect(h.db.q<any>("SELECT action FROM audit_log").map((r) => r.action)).toEqual(
      expect.arrayContaining(["telegram.login_code_requested", "telegram.connected"]),
    );
  });

  it("rate-limits login attempts per admin", async () => {
    const h = await loggedInHarness();
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await h.admin.post("/api/admin/telegram/login/verify-code", { code: "12345" })).status);
    expect(codes).toContain(429);
  });

  it("supports logout and reports disconnected", async () => {
    const h = await loggedInHarness();
    h.gateway.current = "connected";
    const r = await h.admin.post("/api/admin/telegram/logout");
    expect(((await r.json()) as any).status).toBe("disconnected");
    expect(h.db.q<any>("SELECT encrypted_session_reference AS ref FROM telegram_accounts")[0].ref).toBeNull();
  });

  it("reports a clear error status when the Telegram service is unreachable", async () => {
    const h = await loggedInHarness();
    h.serviceDown.v = true;
    const r = await h.admin.get("/api/admin/telegram/status");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.status).toBe("error");
    expect(body.hint).toMatch(/telegram-service/);
  });
});

describe("channel configuration", () => {
  it("refuses to configure a channel before a Telegram account is connected", async () => {
    const h = await loggedInHarness();
    const r = await h.admin.post("/api/admin/channels", { channel: CHANNEL_ID });
    expect(r.status).toBe(502); // service answered 503 not_connected → surfaced as a dependency error
    expect(((await r.json()) as any).error.code).toBe("not_connected");
  });

  it("validates access to the channel and rejects inaccessible ones", async () => {
    const h = await loggedInHarness();
    h.gateway.current = "connected";
    const r = await h.admin.post("/api/admin/channels", { channel: "-1009999999999" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe("channel_inaccessible");
    expect(h.db.q("SELECT 1 FROM channels")).toHaveLength(0);
  });

  it("rejects malformed channel input (e.g. URLs) at validation", async () => {
    const h = await loggedInHarness();
    h.gateway.current = "connected";
    for (const bad of ["https://t.me/evil", "../../etc/passwd", "a b", ""]) {
      expect((await h.admin.post("/api/admin/channels", { channel: bad })).status, bad).toBe(400);
    }
  });

  it("configures a channel without importing anything until the admin confirms", async () => {
    const h = await loggedInHarness();
    h.gateway.current = "connected";
    h.gateway.addVideos([1, 2, 3]);
    const created = await h.admin.post("/api/admin/channels", { channel: CHANNEL_ID });
    expect(created.status).toBe(201);
    const ch = (await created.json()) as any;
    expect(ch).toMatchObject({ title: "Test Channel", importConfirmed: false, videoCount: 0 });
    expect(h.db.q("SELECT 1 FROM videos")).toHaveLength(0);
    expect(h.db.q("SELECT 1 FROM sync_jobs")).toHaveLength(0);

    const noConfirm = await h.admin.post(`/api/admin/channels/${ch.id}/sync`, {});
    expect(noConfirm.status).toBe(400);
    const falseConfirm = await h.admin.post(`/api/admin/channels/${ch.id}/sync`, { confirm: false });
    expect(falseConfirm.status).toBe(400);
    expect(h.db.q("SELECT 1 FROM sync_jobs")).toHaveLength(0);
  });

  it("is idempotent when the same channel is configured twice", async () => {
    const h = await loggedInHarness();
    h.gateway.current = "connected";
    await h.admin.post("/api/admin/channels", { channel: CHANNEL_ID });
    await h.admin.post("/api/admin/channels", { channel: "@mychannel" });
    expect(h.db.q("SELECT 1 FROM channels")).toHaveLength(1);
  });
});

describe("indexing", () => {
  it("indexes the whole channel across multiple history pages with a persisted cursor", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos(Array.from({ length: 250 }, (_, i) => i + 1));
    const channelId = await h.seedLibrary();
    expect(h.db.q<any>("SELECT COUNT(*) AS n FROM videos WHERE channel_id = ?", channelId)[0].n).toBe(250);
    expect(h.gateway.historyCalls).toBe(3); // 100 + 100 + 50: bounded pages, never the whole history at once
    const job = h.db.q<any>("SELECT * FROM sync_jobs")[0];
    expect(job).toMatchObject({ status: "completed", job_type: "initial", processed_count: 250 });
    expect(job.cursor).toBe("1");
    const ch = h.db.q<any>("SELECT * FROM channels")[0];
    expect(ch.sync_status).toBe("idle");
    expect(ch.last_synced_at).toBeGreaterThan(0);
  });

  it("extracts and stores the metadata fields", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([10], () => ({ title: "Big Buck Bunny", description: "A rabbit.", tags: ["animation", "blender"], durationSeconds: 596, fileSizeBytes: 5_000_000, width: 1920, height: 1080 }));
    await h.seedLibrary();
    expect(h.db.q<any>("SELECT * FROM videos")[0]).toMatchObject({
      telegram_message_id: 10, title: "Big Buck Bunny", description: "A rabbit.", tags: "animation blender",
      duration_seconds: 596, file_size_bytes: 5_000_000, mime_type: "video/mp4", width: 1920, height: 1080,
      thumbnail_reference: "tg", availability_status: "available",
    });
  });

  it("prevents duplicates: re-syncing the same channel leaves one row per message", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2, 3, 4, 5]);
    const channelId = await h.seedLibrary();
    for (let i = 0; i < 2; i++) {
      await h.admin.post(`/api/admin/channels/${channelId}/sync`, { confirm: true, mode: "resync" });
      await h.flush();
      await h.drainJobs();
    }
    expect(h.db.q<any>("SELECT COUNT(*) AS n FROM videos")[0].n).toBe(5);
    expect(() => h.db.raw.exec("INSERT INTO videos (channel_id, telegram_message_id, title, published_at) VALUES (1, 3, 'dup', 1)")).toThrow(/UNIQUE/);
  });

  it("does not start a second concurrent job for the same channel", async () => {
    const h = await loggedInHarness();
    h.gateway.current = "connected";
    h.gateway.addVideos([1]);
    const ch = (await (await h.admin.post("/api/admin/channels", { channel: CHANNEL_ID })).json()) as any;
    const a = await h.admin.post(`/api/admin/channels/${ch.id}/sync`, { confirm: true });
    const b = await h.admin.post(`/api/admin/channels/${ch.id}/sync`, { confirm: true });
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(((await b.json()) as any).created).toBe(false);
  });

  it("incrementally picks up only newly published videos", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2, 3]);
    const channelId = await h.seedLibrary();
    const callsBefore = h.gateway.historyCalls;
    h.gateway.addVideos([4, 5]);
    await h.admin.post(`/api/admin/channels/${channelId}/sync`, { confirm: true, mode: "incremental" });
    await h.flush();
    await h.drainJobs();
    expect(h.db.q<any>("SELECT COUNT(*) AS n FROM videos")[0].n).toBe(5);
    const inc = h.db.q<any>("SELECT * FROM sync_jobs WHERE job_type = 'incremental'")[0];
    expect(inc.floor_message_id).toBe(3);
    expect(inc.processed_count).toBe(2); // only the two new messages were touched
    expect(h.gateway.historyCalls - callsBefore).toBe(1);
  });

  it("flags formats browsers can't play as unsupported and hides them from visitors", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2], (id) => (id === 2 ? { mimeType: "video/x-matroska", supported: false } : {}));
    await h.seedLibrary();
    expect(h.db.q<any>("SELECT availability_status AS s FROM videos WHERE telegram_message_id = 2")[0].s).toBe("unsupported");
    const list = (await (await h.admin.get("/api/admin/videos?status=available")).json()) as any;
    expect(list.items).toHaveLength(1);
  });

  it("marks deleted messages as deleted on a verify job and hides them", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2, 3]);
    const channelId = await h.seedLibrary();
    h.gateway.messages.find((m) => m.id === 2)!.deleted = true;
    await h.admin.post(`/api/admin/channels/${channelId}/sync`, { confirm: true, mode: "verify" });
    await h.flush();
    await h.drainJobs();
    expect(h.db.q<any>("SELECT availability_status AS s FROM videos WHERE telegram_message_id = 2")[0].s).toBe("deleted");
    expect(((await (await h.admin.get("/api/admin/videos?status=available")).json()) as any).items).toHaveLength(2);
  });

  it("re-indexes a single video and picks up edited captions", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2]);
    await h.seedLibrary();
    const row = h.db.q<any>("SELECT id FROM videos WHERE telegram_message_id = 2")[0];
    h.gateway.messages.find((m) => m.id === 2)!.video!.title = "Edited title";
    const r = await h.admin.post(`/api/admin/videos/${row.id}/reindex`);
    expect(r.status).toBe(202);
    await h.flush();
    await h.drainJobs();
    expect(h.db.q<any>("SELECT title FROM videos WHERE id = ?", row.id)[0].title).toBe("Edited title");
  });
});

describe("failure handling", () => {
  it("backs off on transient Telegram failures and then succeeds, without losing progress", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos(Array.from({ length: 150 }, (_, i) => i + 1));
    h.gateway.failHistory = { remaining: 2, status: 503, code: "telegram_unavailable" };
    await h.seedLibrary();
    expect(h.db.q<any>("SELECT COUNT(*) AS n FROM videos")[0].n).toBe(150);
    expect(h.db.q<any>("SELECT status FROM sync_jobs")[0].status).toBe("completed");
  });

  it("delays retries (exponential backoff) instead of hammering Telegram", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2, 3]);
    h.gateway.failHistory = { remaining: 99, status: 503, code: "telegram_unavailable" };
    h.gateway.current = "connected";
    const ch = (await (await h.admin.post("/api/admin/channels", { channel: CHANNEL_ID })).json()) as any;
    await h.admin.post(`/api/admin/channels/${ch.id}/sync`, { confirm: true });
    await h.flush();
    const before = h.gateway.historyCalls;
    await runSyncTick(h.env, 1000); // immediate second tick must NOT call Telegram again (job is backing off)
    await runSyncTick(h.env, 1000);
    expect(h.gateway.historyCalls).toBe(before);
    const job = h.db.q<any>("SELECT * FROM sync_jobs")[0];
    expect(job.status).toBe("running");
    expect(job.attempts).toBe(1);
    expect(job.error_message).toBeTruthy();
  });

  it("fails the job visibly on a permanent error, keeps progress, and a retry resumes from the saved cursor", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos(Array.from({ length: 150 }, (_, i) => i + 1));
    h.gateway.current = "connected";
    const ch = (await (await h.admin.post("/api/admin/channels", { channel: CHANNEL_ID })).json()) as any;

    // Page 1 (ids 150..51) succeeds; page 2 hits a permanent error (access revoked mid-sync).
    // Permanent errors fail at once; unknown/5xx errors are retried with backoff first (tested above).
    const original = h.gateway.historyPage.bind(h.gateway);
    let calls = 0;
    h.gateway.historyPage = async (...args) => {
      if (++calls >= 2) throw new ServiceError(403, "channel_inaccessible", "This account can no longer access that channel.");
      return original(...args);
    };
    await h.admin.post(`/api/admin/channels/${ch.id}/sync`, { confirm: true });
    await h.flush(); // runs the job: page 1 stored, page 2 fails

    const failed = h.db.q<any>("SELECT * FROM sync_jobs")[0];
    expect(failed.status).toBe("failed");
    expect(failed.error_message).toBeTruthy();
    expect(failed.processed_count).toBe(100);
    expect(failed.cursor).toBe("51"); // lowest message id of the last completed page
    expect(h.db.q<any>("SELECT COUNT(*) AS n FROM videos")[0].n).toBe(100);
    expect(h.db.q<any>("SELECT sync_status AS s FROM channels")[0].s).toBe("error");

    // Telegram is healthy again. Retry from the dashboard: a fresh job resumes at the stored cursor.
    h.gateway.historyPage = original;
    h.gateway.historyCalls = 0;
    const retry = await h.admin.post(`/api/admin/sync-jobs/${failed.id}/retry`);
    expect(retry.status).toBe(202);
    await h.flush();
    await h.drainJobs();
    expect(h.gateway.historyCalls).toBe(1); // only the remaining 50 were fetched — no re-crawl from the top
    expect(h.db.q<any>("SELECT COUNT(*) AS n FROM videos")[0].n).toBe(150);
    const jobs = h.db.q<any>("SELECT * FROM sync_jobs ORDER BY id");
    expect(jobs[1]).toMatchObject({ status: "completed", cursor: "1", processed_count: 150 });
    expect(h.db.q<any>("SELECT sync_status AS s FROM channels")[0].s).toBe("idle");
  });

  it("only allows retrying failed or cancelled jobs", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1]);
    await h.seedLibrary();
    const job = h.db.q<any>("SELECT id FROM sync_jobs")[0];
    expect((await h.admin.post(`/api/admin/sync-jobs/${job.id}/retry`)).status).toBe(409);
    expect((await h.admin.post("/api/admin/sync-jobs/99999/retry")).status).toBe(404);
  });

  it("recovers jobs whose worker died (stale heartbeat)", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2]);
    h.gateway.current = "connected";
    const ch = (await (await h.admin.post("/api/admin/channels", { channel: CHANNEL_ID })).json()) as any;
    h.db.raw.exec(`INSERT INTO sync_jobs (channel_id, job_type, status, started_at, heartbeat_at) VALUES (${ch.id}, 'initial', 'running', unixepoch() - 900, unixepoch() - 600)`);
    await runSyncTick(h.env, 2000);
    expect(h.db.q<any>("SELECT status FROM sync_jobs")[0].status).toBe("completed");
    expect(h.db.q<any>("SELECT COUNT(*) AS n FROM videos")[0].n).toBe(2);
  });

  it("lists jobs with status for the dashboard and exposes an overview", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1, 2]);
    await h.seedLibrary();
    const jobs = (await (await h.admin.get("/api/admin/sync-jobs")).json()) as any;
    expect(jobs.items[0]).toMatchObject({ status: "completed", jobType: "initial", processedCount: 2 });
    const ov = (await (await h.admin.get("/api/admin/overview")).json()) as any;
    expect(ov.videos.available).toBe(2);
  });

  it("audits administrative actions", async () => {
    const h = await loggedInHarness();
    h.gateway.addVideos([1]);
    await h.seedLibrary();
    const actions = h.db.q<any>("SELECT action FROM audit_log").map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.setup_completed", "channel.configured", "channel.sync_started"]));
    const log = (await (await h.admin.get("/api/admin/audit-log")).json()) as any;
    expect(log.items.length).toBeGreaterThan(2);
  });
});
