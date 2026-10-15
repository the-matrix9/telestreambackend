export type RangeResult =
  | { kind: "none" }
  | { kind: "partial"; start: number; end: number } // inclusive
  | { kind: "unsatisfiable" };

/**
 * Parse an HTTP Range header (RFC 9110 §14) for a resource of `size` bytes.
 * Only the first range of a multi-range request is honoured (a server may
 * legitimately answer a multi-range request with a single range).
 * `maxSpan` bounds the response length so one request cannot pin a stream open.
 */
export function parseRange(header: string | null | undefined, size: number, maxSpan = Infinity): RangeResult {
  if (!header) return { kind: "none" };
  const m = /^bytes=(.+)$/i.exec(header.trim());
  if (!m) return { kind: "none" }; // unknown unit → ignore header, serve 200
  const first = m[1]!.split(",")[0]!.trim();
  const r = /^(\d*)-(\d*)$/.exec(first);
  if (!r) return { kind: "none" };
  const [, a = "", b = ""] = r;
  if (a === "" && b === "") return { kind: "none" };
  if (size <= 0) return { kind: "unsatisfiable" };

  let start: number;
  let end: number;
  if (a === "") {
    // suffix range: last N bytes
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Number(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: "none" };
    if (start >= size) return { kind: "unsatisfiable" };
    if (end < start) return { kind: "none" }; // syntactically invalid → ignore
    end = Math.min(end, size - 1);
  }
  if (end - start + 1 > maxSpan) end = start + maxSpan - 1;
  return { kind: "partial", start, end };
}
