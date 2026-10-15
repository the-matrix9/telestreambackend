/** WebCrypto helpers shared by the Worker API and the Node telegram-service. */
const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/* ───────── service-to-service request signing ─────────
 * signature = HMAC-SHA256(secret, `${ts}\n${METHOD}\n${pathWithQuery}\n${sha256(body)}`)
 * Receiver rejects timestamps outside ±60 s to limit replay.
 */
export const SIGNATURE_HEADER = "x-ts-signature";
export const TIMESTAMP_HEADER = "x-ts-timestamp";
export const SIGNATURE_MAX_SKEW_SECONDS = 60;

export async function signServiceRequest(
  secret: string,
  method: string,
  pathWithQuery: string,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const bodyHash = await sha256Hex(body);
  const sig = await hmacHex(secret, `${nowSeconds}\n${method.toUpperCase()}\n${pathWithQuery}\n${bodyHash}`);
  return { [TIMESTAMP_HEADER]: String(nowSeconds), [SIGNATURE_HEADER]: sig };
}

export async function verifyServiceRequest(
  secret: string,
  method: string,
  pathWithQuery: string,
  body: string,
  headers: { timestamp: string | null | undefined; signature: string | null | undefined },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || !headers.signature) return false;
  if (Math.abs(nowSeconds - ts) > SIGNATURE_MAX_SKEW_SECONDS) return false;
  const expected = await signServiceRequest(secret, method, pathWithQuery, body, ts);
  return safeEqual(expected[SIGNATURE_HEADER]!, headers.signature);
}

/* ───────── short-lived signed playback tokens ───────── */
export interface PlaybackClaims {
  vid: number;
  exp: number; // unix seconds
}

export async function signPlaybackToken(secret: string, claims: PlaybackClaims): Promise<string> {
  const payload = toBase64Url(enc.encode(JSON.stringify(claims)));
  const sig = await hmacHex(secret, `pb1.${payload}`);
  return `${payload}.${sig}`;
}

export async function verifyPlaybackToken(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<PlaybackClaims | null> {
  const [payload, sig, ...rest] = token.split(".");
  if (!payload || !sig || rest.length) return null;
  const expected = await hmacHex(secret, `pb1.${payload}`);
  if (!safeEqual(expected, sig)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as PlaybackClaims;
    if (typeof claims.vid !== "number" || typeof claims.exp !== "number") return null;
    if (claims.exp < nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}
