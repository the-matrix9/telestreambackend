import { vi } from "vitest";
import { createApp } from "../../apps/api/src/app";
import type { Bindings } from "../../apps/api/src/env";
import { __resetMemoryLimiterForTests } from "../../apps/api/src/lib/ratelimit";
import { __activeStreamsForTests } from "../../apps/api/src/routes/public";
import { runSyncTick } from "../../apps/api/src/lib/sync";
import { createServiceApp } from "../../apps/telegram-service/src/app";
import { StreamSlots } from "../../apps/telegram-service/src/streaming";
import { FakeD1 } from "./d1";
import { CHANNEL_ID, FakeGateway, SECRET_2FA, SECRET_CODE } from "./fake-gateway";

export const ORIGIN = "https://telestream.test";
export const TG_URL = "https://tg.telestream.test";
export const TG_SECRET = "s".repeat(48);
export const SETUP_TOKEN = "setup-token-123456";
export const ADMIN = { username: "admin", password: "correct-horse-battery" };

export interface Harness {
  db: FakeD1;
  gateway: FakeGateway;
  env: Bindings;
  /** pending waitUntil work */
  flush(): Promise<void>;
  req(path: string, init?: RequestInit & { ip?: string }): Promise<Response>;
  /** Cookie-carrying admin client (CSRF + Origin handled). */
  admin: AdminClient;
  serviceDown: { v: boolean };
  slots: StreamSlots;
  /** Connect Telegram, configure the channel and run the first sync to completion. */
  seedLibrary(): Promise<number>;
  /** Run sync ticks until no pending/running jobs remain (bypassing backoff delays). */
  drainJobs(): Promise<void>;
}

export class AdminClient {
  cookie = "";
  csrf = "";
  constructor(private readonly h: () => Harness) {}

  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = { origin: ORIGIN, ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers["x-csrf-token"] = this.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.h().req(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) {
      const first = set.split(";")[0]!;
      this.cookie = first.endsWith("=") ? "" : first;
    }
    return res;
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b?: unknown) => this.call("POST", p, b ?? {});

  async setupOrLogin(): Promise<void> {
    const res = await this.post("/api/admin/auth/setup", { setupToken: SETUP_TOKEN, ...ADMIN });
    if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
    this.csrf = ((await res.json()) as { csrf: string }).csrf;
  }
}

export function createHarness(): Harness {
  const db = new FakeD1();
  const gateway = new FakeGateway();
  const slots = new StreamSlots(50);
  const serviceApp = createServiceApp({ gateway, serviceSecret: TG_SECRET, slots });
  const serviceDown = { v: false };
  __resetMemoryLimiterForTests();
  __activeStreamsForTests().clear();

  // The API talks to the telegram-service over real signed HTTP; route that fetch to the service app.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(TG_URL)) throw new Error(`Unexpected outbound fetch in test: ${url}`);
    if (serviceDown.v) throw new TypeError("connect ECONNREFUSED");
    return serviceApp.fetch(new Request(url, init));
  });

  const env = {
    DB: db as unknown as D1Database,
    APP_ORIGIN: ORIGIN,
    API_PUBLIC_URL: "https://api.telestream.test",
    TG_SERVICE_URL: TG_URL,
    TG_SERVICE_SECRET: TG_SECRET,
    PLAYBACK_SECRET: "p".repeat(48),
    SETUP_TOKEN,
    PASSWORD_PEPPER: "pepper-for-tests",
    ENVIRONMENT: "production",
  } satisfies Bindings;

  const app = createApp();
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;

  const harness: Harness = {
    db,
    gateway,
    env,
    slots,
    serviceDown,
    async flush() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
    async req(path, init = {}) {
      const { ip, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("cf-connecting-ip", ip ?? "203.0.113.7");
      return app.request(`${ORIGIN}${path}`, { ...rest, headers }, env, ctx);
    },
    admin: undefined as unknown as AdminClient,
    async drainJobs() {
      for (let i = 0; i < 200; i++) {
        const active = db.q<{ n: number }>("SELECT COUNT(*) AS n FROM sync_jobs WHERE status IN ('pending','running')")[0]!.n;
        if (!active) return;
        db.raw.exec("UPDATE sync_jobs SET heartbeat_at = 0 WHERE status = 'running'"); // skip backoff waits
        await runSyncTick(env, 2000);
      }
      throw new Error("jobs did not drain");
    },
    async seedLibrary() {
      const a = harness.admin;
      gateway.current = "connected";
      const ch = (await (await a.post("/api/admin/channels", { channel: CHANNEL_ID })).json()) as { id: number };
      await a.post(`/api/admin/channels/${ch.id}/sync`, { confirm: true, mode: "initial" });
      await harness.flush();
      await harness.drainJobs();
      return ch.id;
    },
  };
  harness.admin = new AdminClient(() => harness);
  return harness;
}

export async function loggedInHarness(): Promise<Harness> {
  const h = createHarness();
  await h.admin.setupOrLogin();
  return h;
}

export const LOGIN = { SECRET_CODE, SECRET_2FA };
export { CHANNEL_ID };
