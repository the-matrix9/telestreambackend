import { parseRange } from "@telestream/shared";
import { ServiceError } from "./errors";
import { log } from "./logger";

/**
 * A seekable, ranged byte source. The GramJS adapter implements this on top of upload.GetFile;
 * tests implement it over an in-memory buffer. `read` MUST yield bounded chunks (never the whole file).
 */
export interface MediaSource {
  size: number;
  mimeType: string;
  /** Yields bytes [start, endInclusive]. Must stop promptly when `signal` aborts. */
  read(start: number, endInclusive: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface StreamLimits {
  /** Max bytes served for one Range response; clients simply issue the next range. */
  maxRangeBytes: number;
  /** Abort a stream when Telegram produces no bytes for this long. */
  chunkTimeoutMs: number;
}

export const DEFAULT_LIMITS: StreamLimits = {
  maxRangeBytes: 32 * 1024 * 1024,
  chunkTimeoutMs: 30_000,
};

/** Counting semaphore with a bounded wait queue so slow Telegram downloads cannot exhaust the process. */
export class StreamSlots {
  private active = 0;
  constructor(private readonly max: number) {}
  get inUse(): number { return this.active; }
  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (!released) { released = true; this.active--; }
    };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { onTimeout(); reject(new ServiceError(504, "stream_timeout", "Telegram stalled while streaming.")); }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Build the HTTP response for a media request, implementing RFC 9110 range semantics:
 *  - no/ignored Range → 200 with the full body
 *  - valid Range → 206 + Content-Range
 *  - start beyond EOF → 416 + `Content-Range: bytes * /size`
 * The body is a pull-based stream: one chunk is fetched at a time (back-pressure), the upstream read
 * is cancelled when the client disconnects, and a stalled upstream is cut off by a per-chunk timeout.
 */
export function buildStreamResponse(
  source: MediaSource,
  method: string,
  rangeHeader: string | null,
  slots: StreamSlots,
  clientSignal: AbortSignal | undefined,
  limits: StreamLimits = DEFAULT_LIMITS,
): Response {
  const size = source.size;
  const range = parseRange(rangeHeader, size, limits.maxRangeBytes);
  const baseHeaders: Record<string, string> = {
    "Content-Type": source.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };

  if (range.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${size}` } });
  }

  let status = 200;
  let start = 0;
  let end = size - 1;
  const headers = { ...baseHeaders };
  if (range.kind === "partial") {
    status = 206;
    start = range.start;
    end = range.end;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  const length = size === 0 ? 0 : end - start + 1;
  headers["Content-Length"] = String(length);

  if (method === "HEAD" || length === 0) return new Response(null, { status, headers });

  const release = slots.tryAcquire();
  if (!release) throw new ServiceError(503, "busy", "Too many active streams. Try again shortly.", 3);

  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  clientSignal?.addEventListener("abort", onClientAbort, { once: true });
  const iterator = source.read(start, end, ac.signal)[Symbol.asyncIterator]();
  let sent = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clientSignal?.removeEventListener("abort", onClientAbort);
    release();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await withTimeout(iterator.next(), limits.chunkTimeoutMs, () => ac.abort());
        if (next.done) {
          finish();
          if (sent !== length) controller.error(new Error(`short read: ${sent}/${length}`));
          else controller.close();
          return;
        }
        // Defensive: never emit more than promised in Content-Length.
        const chunk = sent + next.value.byteLength > length ? next.value.subarray(0, length - sent) : next.value;
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent >= length) {
          ac.abort(); // stop upstream prefetching immediately
          await iterator.return?.(undefined).catch(() => undefined);
          finish();
          controller.close();
        }
      } catch (err) {
        ac.abort();
        finish();
        log("warn", "stream_aborted", { sent, length, reason: err instanceof Error ? err.message : "error" });
        controller.error(err);
      }
    },
    async cancel() {
      ac.abort();
      await iterator.return?.(undefined).catch(() => undefined);
      finish();
    },
  });

  return new Response(body, { status, headers });
}
