import { signServiceRequest } from "@telestream/shared";
import { describe, expect, it } from "vitest";
import { createServiceApp } from "../src/app";
import type { TelegramGateway } from "../src/gateway";
import { StreamSlots, type MediaSource } from "../src/streaming";

const SECRET = "x".repeat(40);
const SIZE = 3000;
const data = new Uint8Array(SIZE).map((_, i) => i % 200);

const source: MediaSource = {
  size: SIZE,
  mimeType: "video/mp4",
  async *read(start, end) { yield data.slice(start, end + 1); },
};

const gateway = {
  status: () => ({ status: "connected", accountLabel: "@tester" }),
  state: () => "connected",
  requestCode: async () => ({ status: "awaiting_code", accountLabel: null }),
  getMediaSource: async (_c: string, id: number) => {
    if (id === 404) throw Object.assign(new Error("gone"), { errorMessage: "x" });
    return source;
  },
} as unknown as TelegramGateway;

const app = createServiceApp({ gateway, serviceSecret: SECRET, slots: new StreamSlots(4) });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, secret = SECRET) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const sig = await signServiceRequest(secret, method, path, payload);
  return app.request(`http://svc${path}`, { method, headers: { ...sig, ...(payload ? { "content-type": "application/json" } : {}), ...headers }, body: payload || undefined });
}

describe("telegram-service HTTP", () => {
  it("rejects unsigned requests", async () => {
    expect((await app.request("http://svc/internal/status")).status).toBe(401);
  });

  it("rejects a wrong secret and a stale timestamp", async () => {
    expect((await call("GET", "/internal/status", undefined, {}, "y".repeat(40))).status).toBe(401);
    const old = await signServiceRequest(SECRET, "GET", "/internal/status", "", Math.floor(Date.now() / 1000) - 600);
    expect((await app.request("http://svc/internal/status", { headers: old })).status).toBe(401);
  });

  it("does not let a signature for one path be replayed on another", async () => {
    const sig = await signServiceRequest(SECRET, "GET", "/internal/status", "");
    expect((await app.request("http://svc/internal/health", { headers: sig })).status).toBe(401);
  });

  it("serves status when signed", async () => {
    const r = await call("GET", "/internal/status");
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("connected");
  });

  it("validates input", async () => {
    const r = await call("POST", "/internal/login/request-code", { phone: "not-a-phone" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("validation_error");
  });

  it("validates the channel parameter, so arbitrary URLs cannot be smuggled in", async () => {
    const r = await call("GET", `/internal/stream?channel=${encodeURIComponent("http://evil.test/x")}&message=1`);
    expect(r.status).toBe(400);
  });

  it("streams a byte range end-to-end through the signed endpoint", async () => {
    const r = await call("GET", "/internal/stream?channel=-1001234567890&message=7", undefined, { range: "bytes=10-19" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 10-19/${SIZE}`);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(data.slice(10, 20));
  });

  it("returns 416 for unsatisfiable ranges", async () => {
    const r = await call("GET", "/internal/stream?channel=-1001234567890&message=7", undefined, { range: "bytes=9999-" });
    expect(r.status).toBe(416);
  });
});
