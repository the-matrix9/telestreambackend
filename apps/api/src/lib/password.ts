import { fromBase64Url, hmacHex, safeEqual, toBase64Url } from "@telestream/shared";

/**
 * Password hashing: PBKDF2-HMAC-SHA256 via WebCrypto, then an HMAC with a server-side pepper.
 *
 * Why not Argon2id? Argon2id needs a WASM/JS implementation that is slow and memory-hungry on the
 * Workers CPU budget. Workers' native PBKDF2 is capped at 100,000 iterations, so that is the
 * iteration count used. The pepper (a Worker secret, not in D1) means a stolen database alone
 * cannot be attacked offline. See docs/SECURITY.md for the trade-off and the upgrade path.
 */
export const PBKDF2_ITERATIONS = 100_000;
const enc = new TextEncoder();

async function derive(password: string, salt: Uint8Array, iterations: number, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return hmacHex(pepper, toBase64Url(bits));
}

export async function hashPassword(password: string, pepper = "", iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations, pepper);
  return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string, pepper = ""): Promise<boolean> {
  const [scheme, iterStr, saltStr, hash] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !iterStr || !saltStr || !hash) return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
  const computed = await derive(password, fromBase64Url(saltStr), iterations, pepper);
  return safeEqual(computed, hash);
}

/** A throwaway hash so unknown-user logins cost the same as real ones. */
let dummy: Promise<string> | null = null;
export function dummyVerify(password: string, pepper = ""): Promise<boolean> {
  dummy ??= hashPassword("not-a-real-password", pepper);
  return dummy.then((h) => verifyPassword(password, h, pepper)).then(() => false);
}
