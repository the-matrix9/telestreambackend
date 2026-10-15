import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "../apps/api/src/lib/password";
import { redact } from "../apps/api/src/lib/log";
import { ADMIN, createHarness, loggedInHarness, ORIGIN, SETUP_TOKEN } from "./helpers/harness";

afterEach(() => vi.unstubAllGlobals());

describe("first-run admin setup", () => {
  it("reports setupRequired until an admin exists", async () => {
    const h = createHarness();
    const me = await (await h.req("/api/admin/auth/me")).json();
    expect(me).toMatchObject({ authenticated: false, setupRequired: true });
  });

  it("rejects a wrong setup token and records it in the audit log", async () => {
    const h = createHarness();
    const r = await h.admin.post("/api/admin/auth/setup", { setupToken: "wrong-token-xx", ...ADMIN });
    expect(r.status).toBe(403);
    expect(h.db.q("SELECT 1 FROM admin_users")).toHaveLength(0);
    expect(h.db.q("SELECT action FROM audit_log").map((x: any) => x.action)).toContain("admin.setup_failed");
  });

  it("enforces password strength", async () => {
    const h = createHarness();
    const r = await h.admin.post("/api/admin/auth/setup", { setupToken: SETUP_TOKEN, username: "admin", password: "short" });
    expect(r.status).toBe(400);
  });

  it("creates the first admin, issues a hardened session cookie, and refuses a second setup", async () => {
    const h = createHarness();
    const r = await h.admin.post("/api/admin/auth/setup", { setupToken: SETUP_TOKEN, ...ADMIN });
    expect(r.status).toBe(201);
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-ts_admin=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i); // required by the __Host- prefix

    const again = await createHarnessSetupAgain(h);
    expect(again.status).toBe(409);
    expect(h.db.q("SELECT COUNT(*) AS n FROM admin_users")[0]).toMatchObject({ n: 1 });
  });

  it("stores only a salted, peppered hash — never the password — and only a hash of the session token", async () => {
    const h = await loggedInHarness();
    const user = h.db.q<{ password_hash: string }>("SELECT password_hash FROM admin_users")[0]!;
    expect(user.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(user.password_hash).not.toContain(ADMIN.password);
    const token = h.admin.cookie.split("=")[1]!;
    const sess = h.db.q<{ token_hash: string }>("SELECT token_hash FROM admin_sessions")[0]!;
    expect(sess.token_hash).not.toBe(token);
    expect(sess.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

async function createHarnessSetupAgain(h: ReturnType<typeof createHarness>) {
  return h.req("/api/admin/auth/setup", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ setupToken: SETUP_TOKEN, username: "second", password: "another-long-password" }),
  });
}

describe("password hashing", () => {
  it("verifies correct and rejects wrong passwords / wrong pepper", async () => {
    const hash = await hashPassword("hunter2-hunter2", "pep", 1000);
    expect(await verifyPassword("hunter2-hunter2", hash, "pep")).toBe(true);
    expect(await verifyPassword("hunter3-hunter3", hash, "pep")).toBe(false);
    expect(await verifyPassword("hunter2-hunter2", hash, "other-pepper")).toBe(false);
  });
  it("salts every hash and rejects malformed or downgraded stored values", async () => {
    expect(await hashPassword("same", "p", 1000)).not.toBe(await hashPassword("same", "p", 1000));
    expect(await verifyPassword("x", "plaintext", "")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2-sha256$1$aaaa$bbbb", "")).toBe(false); // absurdly low iteration count
  });
});

describe("login", () => {
  it("rejects bad credentials with one generic message (no user enumeration)", async () => {
    const h = await loggedInHarness();
    h.admin.cookie = "";
    const wrongPw = await h.admin.post("/api/admin/auth/login", { username: "admin", password: "nope-nope-nope" });
    const wrongUser = await h.admin.post("/api/admin/auth/login", { username: "ghost", password: "nope-nope-nope" });
    expect(wrongPw.status).toBe(401);
    expect(wrongUser.status).toBe(401);
    expect(((await wrongPw.json()) as any).error.message).toBe(((await wrongUser.json()) as any).error.message);
  });

  it("locks out repeated failures for the account (429 + Retry-After)", async () => {
    const h = await loggedInHarness();
    h.admin.cookie = "";
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await h.req("/api/admin/auth/login", {
        method: "POST",
        ip: `198.51.100.${i}`, // different IPs: the per-account limiter must still trip
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong-wrong-wrong" }),
      });
      statuses.push(r.status);
      if (r.status === 429) expect(r.headers.get("retry-after")).toBeTruthy();
    }
    expect(statuses).toContain(429);
    // …and even the right password is refused while locked
    const locked = await h.admin.post("/api/admin/auth/login", { username: "admin", password: ADMIN.password });
    expect(locked.status).toBe(429);
  });

  it("logs a successful login, resets the counter, and returns a CSRF token", async () => {
    const h = await loggedInHarness();
    h.admin.cookie = "";
    const r = await h.admin.post("/api/admin/auth/login", { username: "admin", password: ADMIN.password });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.csrf).toBeTruthy();
    expect(h.db.q("SELECT action FROM audit_log").map((x: any) => x.action)).toContain("admin.login");
  });

  it("rejects login attempts from untrusted origins", async () => {
    const h = await loggedInHarness();
    const r = await h.req("/api/admin/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    });
    expect(r.status).toBe(403);
  });
});

describe("admin session, CSRF and access control", () => {
  it("returns 401 for every admin endpoint without a session", async () => {
    const h = createHarness();
    for (const [m, p] of [["GET", "/api/admin/channels"], ["GET", "/api/admin/videos"], ["GET", "/api/admin/sync-jobs"],
      ["GET", "/api/admin/telegram/status"], ["POST", "/api/admin/channels"], ["GET", "/api/admin/audit-log"]] as const) {
      const r = await h.req(p, { method: m, headers: { origin: ORIGIN } });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it("blocks state-changing requests without the CSRF token", async () => {
    const h = await loggedInHarness();
    const r = await h.req("/api/admin/telegram/logout", { method: "POST", headers: { origin: ORIGIN, cookie: h.admin.cookie } });
    expect(r.status).toBe(403);
  });

  it("blocks state-changing requests from an untrusted Origin even with a valid CSRF token", async () => {
    const h = await loggedInHarness();
    const r = await h.req("/api/admin/telegram/logout", {
      method: "POST",
      headers: { origin: "https://evil.example", cookie: h.admin.cookie, "x-csrf-token": h.admin.csrf },
    });
    expect(r.status).toBe(403);
  });

  it("blocks a forged CSRF token", async () => {
    const h = await loggedInHarness();
    const r = await h.req("/api/admin/telegram/logout", {
      method: "POST",
      headers: { origin: ORIGIN, cookie: h.admin.cookie, "x-csrf-token": "forged" },
    });
    expect(r.status).toBe(403);
  });

  it("invalidates the session server-side on logout (a stolen cookie stops working)", async () => {
    const h = await loggedInHarness();
    const stolen = h.admin.cookie;
    expect((await h.admin.post("/api/admin/auth/logout")).status).toBe(204);
    const r = await h.req("/api/admin/channels", { headers: { cookie: stolen } });
    expect(r.status).toBe(401);
  });

  it("supports revoking every session", async () => {
    const h = await loggedInHarness();
    const stolen = h.admin.cookie;
    expect((await h.admin.post("/api/admin/auth/revoke-all-sessions")).status).toBe(204);
    expect((await h.req("/api/admin/channels", { headers: { cookie: stolen } })).status).toBe(401);
  });

  it("does not accept an expired session", async () => {
    const h = await loggedInHarness();
    h.db.raw.exec("UPDATE admin_sessions SET expires_at = unixepoch() - 1");
    expect((await h.admin.get("/api/admin/channels")).status).toBe(401);
  });

  it("is not vulnerable to SQL injection through credentials", async () => {
    const h = await loggedInHarness();
    h.admin.cookie = "";
    const r = await h.admin.post("/api/admin/auth/login", { username: "admin' OR '1'='1' --", password: "x' OR '1'='1" });
    expect([400, 401]).toContain(r.status);
    expect(h.db.q("SELECT COUNT(*) AS n FROM admin_users")[0]).toMatchObject({ n: 1 });
  });
});

describe("HTTP hardening", () => {
  it("sets security headers on API responses", async () => {
    const h = createHarness();
    const r = await h.req("/api/health");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age=/);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("referrer-policy")).toBeTruthy();
    expect(r.headers.get("x-request-id")).toBeTruthy();
  });

  it("only grants CORS to trusted origins", async () => {
    const h = createHarness();
    const evil = await h.req("/api/health", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await h.req("/api/health", { headers: { origin: ORIGIN } });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const preflight = await h.req("/api/admin/channels", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects oversized request bodies", async () => {
    const h = createHarness();
    const r = await h.req("/api/admin/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "content-length": String(1024 * 1024) },
      body: JSON.stringify({ username: "a".repeat(1000), password: "b" }),
    });
    expect(r.status).toBe(413);
  });

  it("returns consistent JSON errors and never leaks internals", async () => {
    const h = createHarness();
    const notFound = await h.req("/api/does-not-exist");
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: { code: "not_found" } });
    const bad = await h.req("/api/admin/auth/login", { method: "POST", headers: { origin: ORIGIN }, body: "{not json" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("invalid_json");
  });

  it("redacts secrets in structured logs", () => {
    const out = redact({ phone: "+1415", code: "12345", apiHash: "abc", session: "1BV…", nested: { password: "pw", ok: 1 }, title: "fine" }) as any;
    expect(out).toMatchObject({ phone: "[redacted]", code: "[redacted]", apiHash: "[redacted]", session: "[redacted]", title: "fine" });
    expect(out.nested).toMatchObject({ password: "[redacted]", ok: 1 });
  });
});
