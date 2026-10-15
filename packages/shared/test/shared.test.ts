import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, parseRange, safeEqual, signPlaybackToken, signServiceRequest, verifyPlaybackToken, verifyServiceRequest } from "../src/index";

describe("parseRange", () => {
  it("handles absent, malformed and unknown-unit headers by ignoring them", () => {
    for (const h of [undefined, null, "", "items=0-5", "bytes=", "bytes=-", "bytes=abc-def", "bytes=5-2"]) expect(parseRange(h, 100)).toEqual({ kind: "none" });
  });
  it("parses closed, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ kind: "partial", start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ kind: "partial", start: 0, end: 99 });
  });
  it("clamps the end to the file and honours only the first of several ranges", () => {
    expect(parseRange("bytes=50-5000", 100)).toEqual({ kind: "partial", start: 50, end: 99 });
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "partial", start: 0, end: 1 });
  });
  it("reports unsatisfiable ranges (416)", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-1", 0)).toEqual({ kind: "unsatisfiable" });
  });
  it("bounds the span", () => {
    expect(parseRange("bytes=10-", 1000, 100)).toEqual({ kind: "partial", start: 10, end: 109 });
  });
});

describe("service request signing", () => {
  const S = "s".repeat(40);
  it("verifies a good signature and rejects tampering", async () => {
    const h = await signServiceRequest(S, "POST", "/internal/x?a=1", '{"a":1}', 1000);
    const ok = (over: Partial<{ m: string; p: string; b: string; now: number; secret: string }> = {}) =>
      verifyServiceRequest(over.secret ?? S, over.m ?? "POST", over.p ?? "/internal/x?a=1", over.b ?? '{"a":1}', { timestamp: h["x-ts-timestamp"], signature: h["x-ts-signature"] }, over.now ?? 1000);
    expect(await ok()).toBe(true);
    expect(await ok({ m: "GET" })).toBe(false);
    expect(await ok({ p: "/internal/y?a=1" })).toBe(false);
    expect(await ok({ b: '{"a":2}' })).toBe(false);
    expect(await ok({ secret: "t".repeat(40) })).toBe(false);
  });
  it("enforces the 60 s clock-skew window", async () => {
    const h = await signServiceRequest(S, "GET", "/p", "", 1000);
    const v = (now: number) => verifyServiceRequest(S, "GET", "/p", "", { timestamp: h["x-ts-timestamp"], signature: h["x-ts-signature"] }, now);
    expect(await v(1060)).toBe(true);
    expect(await v(1061)).toBe(false);
    expect(await v(939)).toBe(false);
  });
  it("rejects missing headers", async () => {
    expect(await verifyServiceRequest(S, "GET", "/p", "", { timestamp: null, signature: null })).toBe(false);
  });
});

describe("playback tokens", () => {
  const S = "p".repeat(40);
  it("round-trips claims and rejects expiry, tampering and wrong secrets", async () => {
    const t = await signPlaybackToken(S, { vid: 7, exp: 2000 });
    expect(await verifyPlaybackToken(S, t, 1999)).toEqual({ vid: 7, exp: 2000 });
    expect(await verifyPlaybackToken(S, t, 2001)).toBeNull();
    expect(await verifyPlaybackToken("q".repeat(40), t, 1999)).toBeNull();
    const [payload, sig] = t.split(".");
    const forged = btoa(JSON.stringify({ vid: 8, exp: 2000 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(await verifyPlaybackToken(S, `${forged}.${sig}`, 1999)).toBeNull();
    expect(await verifyPlaybackToken(S, `${payload}.${sig}.x`, 1999)).toBeNull();
    expect(await verifyPlaybackToken(S, "garbage", 1999)).toBeNull();
  });
  it("safeEqual is length- and content-sensitive", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("cursors", () => {
  it("round-trips keyset and offset cursors", () => {
    expect(decodeCursor(encodeCursor({ t: "k", p: 123, i: 9 }))).toEqual({ t: "k", p: 123, i: 9 });
    expect(decodeCursor(encodeCursor({ t: "o", o: 40 }))).toEqual({ t: "o", o: 40 });
  });
  it("returns null for empty or corrupt input instead of throwing", () => {
    for (const bad of [undefined, null, "", "!!!", "e30", btoa(JSON.stringify({ t: "x" }))]) expect(decodeCursor(bad)).toBeNull();
  });
});
