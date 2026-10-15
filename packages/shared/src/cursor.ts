import { fromBase64Url, toBase64Url } from "./crypto";

/** Keyset cursor for (published_at DESC, id DESC) listings, or an offset for relevance sort. */
export type Cursor = { t: "k"; p: number; i: number } | { t: "o"; o: number };

export function encodeCursor(c: Cursor): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(c)));
}

export function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromBase64Url(s))) as Cursor;
    if (c.t === "k" && Number.isInteger(c.p) && Number.isInteger(c.i)) return c;
    if (c.t === "o" && Number.isInteger(c.o) && c.o >= 0 && c.o < 10_000) return c;
    return null;
  } catch {
    return null;
  }
}
