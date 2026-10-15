import { describe, expect, it } from "vitest";
import { GramjsGateway } from "../src/gramjs";
import type { Config } from "../src/config";
import { buildStreamResponse, StreamSlots } from "../src/streaming";
import { SessionVault, parseKey } from "../src/vault";
import { randomBytes } from "node:crypto";

const REQ = 512 * 1024;
const SIZE = 3 * REQ + 12_345;
const FILE = new Uint8Array(SIZE).map((_, i) => (i * 7) % 256);

/**
 * Fake GramJS client. Documents carry a "fileReference" version; downloads with a stale version
 * fail with FILE_REFERENCE_EXPIRED exactly like Telegram does, and getMessages hands out a fresh one.
 */
function makeFake(opts: { expireAfterChunks: number }) {
  let currentRef = 1;
  let chunksServed = 0;
  let expired = false;
  const calls = { getMessages: 0, iterDownload: 0, dcIds: [] as unknown[] };
  const mkDoc = () => ({
    className: "Document", id: 123, accessHash: 456, dcId: 4, fileReference: Buffer.from([currentRef]),
    mimeType: "video/mp4", size: SIZE,
    attributes: [{ className: "DocumentAttributeVideo", duration: 60, w: 640, h: 360 }], thumbs: [],
  });
  const fake = {
    async getEntity() { return { className: "Channel" }; },
    async getDialogs() { return []; },
    async getMessages() {
      calls.getMessages++;
      return [{ id: 7, className: "Message", date: 1, message: "t", media: { className: "MessageMediaDocument", document: mkDoc() } }];
    },
    iterDownload(p: { file: { className?: string; fileReference: Buffer }; dcId?: number; offset: { toJSNumber(): number }; limit: number }) {
      calls.iterDownload++;
      // Real GramJS' iterDownload only accepts an InputFileLocation (or a Message / MessageMedia). A bare Document
      // throws exactly this error, which broke playback in production while an over-permissive fake hid it.
      if (p.file.className !== "InputDocumentFileLocation") throw new Error(`Cannot cast ${p.file.className} to any kind of InputFileLocation`);
      calls.dcIds.push(p.dcId); // the file's datacenter must be passed explicitly
      const docRef = p.file.fileReference[0];
      let off = p.offset.toJSNumber();
      let left = p.limit;
      return {
        async close() { /* noop */ },
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (left-- <= 0 || off >= SIZE) return { done: true as const, value: undefined };
              // Simulate Telegram invalidating the reference after N chunks (once).
              if (!expired && chunksServed >= opts.expireAfterChunks) { expired = true; currentRef = 2; }
              if (docRef !== currentRef) throw Object.assign(new Error("x"), { errorMessage: "FILE_REFERENCE_EXPIRED" });
              const buf = Buffer.from(FILE.subarray(off, Math.min(off + REQ, SIZE)));
              off += buf.length;
              chunksServed++;
              return { done: false as const, value: buf };
            },
          };
        },
      };
    },
  };
  return { fake, calls };
}

async function gatewayWith(fake: unknown) {
  const cfg = {} as Config;
  const gw = new GramjsGateway(cfg, new SessionVault("/dev/null", parseKey(randomBytes(32).toString("base64"))));
  Object.assign(gw as unknown as Record<string, unknown>, { client: fake, current: "connected" });
  return gw;
}

describe("Telegram file-reference expiry", () => {
  it("transparently refreshes the reference mid-stream and delivers byte-exact output", async () => {
    const { fake, calls } = makeFake({ expireAfterChunks: 1 });
    const gw = await gatewayWith(fake);
    const source = await gw.getMediaSource("-1001234567890", 7);
    const res = buildStreamResponse(source, "GET", null, new StreamSlots(2), undefined);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.length).toBe(SIZE);
    expect(Buffer.from(out).equals(Buffer.from(FILE))).toBe(true);
    expect(calls.getMessages).toBeGreaterThanOrEqual(2); // initial load + refresh
    expect(calls.dcIds.length).toBeGreaterThan(0);
    expect(calls.dcIds.every((d) => d === 4)).toBe(true); // downloads target the document's own datacenter
  });

  it("serves an unaligned mid-file range correctly (seeking), including across a refresh", async () => {
    const { fake } = makeFake({ expireAfterChunks: 1 });
    const gw = await gatewayWith(fake);
    const source = await gw.getMediaSource("-1001234567890", 7);
    const start = REQ + 1234;
    const end = 2 * REQ + 99;
    const res = buildStreamResponse(source, "GET", `bytes=${start}-${end}`, new StreamSlots(2), undefined);
    expect(res.status).toBe(206);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(Buffer.from(FILE.subarray(start, end + 1)))).toBe(true);
  });

  it("maps a deleted message to media_unavailable (HTTP 410) instead of crashing", async () => {
    const fake = {
      async getEntity() { return {}; },
      async getMessages() { return [{ id: 7, className: "MessageEmpty" }]; },
    };
    const gw = await gatewayWith(fake);
    await expect(gw.getMediaSource("-1001234567890", 7)).rejects.toMatchObject({ status: 410, code: "media_unavailable" });
  });

  it("reports not_connected (503) when no account is logged in", async () => {
    const gw = new GramjsGateway({} as Config, new SessionVault("/dev/null", parseKey(randomBytes(32).toString("base64"))));
    await expect(gw.getMediaSource("-1001234567890", 1)).rejects.toMatchObject({ status: 503, code: "not_connected" });
  });
});
