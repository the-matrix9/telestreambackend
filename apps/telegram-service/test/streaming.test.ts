import { describe, expect, it } from "vitest";
import { buildStreamResponse, StreamSlots, type MediaSource } from "../src/streaming";

const SIZE = 5_000;
const data = new Uint8Array(SIZE).map((_, i) => i % 251);

/** In-memory source that yields small chunks and records cancellation. */
function memorySource(opts: { chunk?: number; stallAfter?: number; onRead?: (s: number, e: number) => void; aborted?: { v: boolean } } = {}): MediaSource {
  const chunk = opts.chunk ?? 700;
  return {
    size: SIZE,
    mimeType: "video/mp4",
    async *read(start, end, signal) {
      opts.onRead?.(start, end);
      let pos = start;
      let sent = 0;
      try {
        while (pos <= end) {
          if (signal.aborted) return;
          if (opts.stallAfter !== undefined && sent >= opts.stallAfter) await new Promise(() => undefined); // never resolves
          const to = Math.min(end, pos + chunk - 1);
          yield data.slice(pos, to + 1);
          sent += to - pos + 1;
          pos = to + 1;
          await Promise.resolve();
        }
      } finally {
        // Runs when the consumer closes the generator early (return()) or the signal aborts.
        if (opts.aborted && pos <= end) opts.aborted.v = true;
      }
    },
  };
}

const slots = () => new StreamSlots(2);
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

describe("buildStreamResponse — range semantics", () => {
  it("serves the whole file with 200 and advertises range support", async () => {
    const r = buildStreamResponse(memorySource(), "GET", null, slots(), undefined);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe(String(SIZE));
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(await bytes(r)).toEqual(data);
  });

  it("serves bytes=100-199 as 206 with the right Content-Range", async () => {
    const r = buildStreamResponse(memorySource(), "GET", "bytes=100-199", slots(), undefined);
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 100-199/${SIZE}`);
    expect(r.headers.get("content-length")).toBe("100");
    expect(await bytes(r)).toEqual(data.slice(100, 200));
  });

  it("handles open-ended ranges (bytes=4000-)", async () => {
    const r = buildStreamResponse(memorySource(), "GET", "bytes=4000-", slots(), undefined);
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 4000-4999/${SIZE}`);
    expect(await bytes(r)).toEqual(data.slice(4000));
  });

  it("handles suffix ranges (bytes=-500)", async () => {
    const r = buildStreamResponse(memorySource(), "GET", "bytes=-500", slots(), undefined);
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 4500-4999/${SIZE}`);
    expect(await bytes(r)).toEqual(data.slice(4500));
  });

  it("clamps an end beyond EOF", async () => {
    const r = buildStreamResponse(memorySource(), "GET", "bytes=4990-99999", slots(), undefined);
    expect(r.headers.get("content-range")).toBe(`bytes 4990-4999/${SIZE}`);
    expect((await bytes(r)).length).toBe(10);
  });

  it("returns 416 with Content-Range: bytes */size when start is past EOF", () => {
    const r = buildStreamResponse(memorySource(), "GET", "bytes=5000-", slots(), undefined);
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe(`bytes */${SIZE}`);
  });

  it("ignores a malformed Range header and serves 200", () => {
    expect(buildStreamResponse(memorySource(), "GET", "bytes=abc", slots(), undefined).status).toBe(200);
    expect(buildStreamResponse(memorySource(), "GET", "items=0-5", slots(), undefined).status).toBe(200);
  });

  it("caps a single range response at maxRangeBytes (client re-requests the rest)", async () => {
    const r = buildStreamResponse(memorySource(), "GET", "bytes=0-", slots(), undefined, { maxRangeBytes: 1000, chunkTimeoutMs: 5000 });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 0-999/${SIZE}`);
    expect((await bytes(r)).length).toBe(1000);
  });

  it("answers HEAD with headers only and does not touch the source or a slot", () => {
    const s = slots();
    let reads = 0;
    const r = buildStreamResponse(memorySource({ onRead: () => reads++ }), "HEAD", "bytes=0-9", s, undefined);
    expect(r.status).toBe(206);
    expect(r.body).toBeNull();
    expect(reads).toBe(0);
    expect(s.inUse).toBe(0);
  });
});

describe("buildStreamResponse — lifecycle", () => {
  it("releases the slot after a complete response", async () => {
    const s = slots();
    const r = buildStreamResponse(memorySource(), "GET", "bytes=0-999", s, undefined);
    expect(s.inUse).toBe(1);
    await bytes(r);
    expect(s.inUse).toBe(0);
  });

  it("cancels upstream reads and frees the slot when the viewer disconnects mid-stream", async () => {
    const s = slots();
    const aborted = { v: false };
    const ac = new AbortController();
    const r = buildStreamResponse(memorySource({ chunk: 100, aborted }), "GET", null, s, ac.signal);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel(); // what the HTTP server does on client disconnect
    await new Promise((res) => setTimeout(res, 10));
    expect(s.inUse).toBe(0);
    expect(aborted.v).toBe(true);
  });

  it("rejects new streams with 503 when all slots are busy", () => {
    const s = new StreamSlots(1);
    buildStreamResponse(memorySource(), "GET", null, s, undefined); // holds the only slot (body never read)
    expect(() => buildStreamResponse(memorySource(), "GET", null, s, undefined)).toThrowError(/Too many active streams/);
  });

  it("times out a stalled upstream, errors the body and frees the slot", async () => {
    const s = slots();
    const r = buildStreamResponse(memorySource({ stallAfter: 700 }), "GET", null, s, undefined, { maxRangeBytes: 1e9, chunkTimeoutMs: 50 });
    await expect(r.arrayBuffer()).rejects.toThrow();
    expect(s.inUse).toBe(0);
  });

  it("serves many concurrent range requests independently and correctly", async () => {
    const s = new StreamSlots(20);
    const ranges = Array.from({ length: 15 }, (_, i) => [i * 300, i * 300 + 250] as const);
    const out = await Promise.all(
      ranges.map(async ([a, b]) => ({ a, b, body: await bytes(buildStreamResponse(memorySource(), "GET", `bytes=${a}-${b}`, s, undefined)) })),
    );
    for (const { a, b, body } of out) expect(body).toEqual(data.slice(a, b + 1));
    expect(s.inUse).toBe(0);
  });
});
