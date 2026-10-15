import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, parseKey, SessionVault } from "../src/vault";

const key = () => randomBytes(32);
const SECRET = "1BVtsOKwBu_SECRET_SESSION_STRING_do_not_leak";

describe("session vault", () => {
  it("round-trips and never stores plaintext on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    const v = new SessionVault(join(dir, "s.enc"), key());
    await v.save(SECRET);
    const onDisk = await readFile(join(dir, "s.enc"), "utf8");
    expect(onDisk.startsWith("v1.")).toBe(true);
    expect(onDisk).not.toContain(SECRET);
    expect(await v.load()).toBe(SECRET);
  });

  it("writes the file with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    await new SessionVault(join(dir, "s.enc"), key()).save(SECRET);
    expect(((await stat(join(dir, "s.enc"))).mode & 0o777)).toBe(0o600);
  });

  it("uses a fresh IV per write", () => {
    const k = key();
    expect(encrypt(SECRET, k)).not.toBe(encrypt(SECRET, k));
  });

  it("refuses to decrypt with the wrong key and detects tampering", async () => {
    const k = key();
    const blob = encrypt(SECRET, k);
    expect(() => decrypt(blob, key())).toThrow();
    const [v, iv, tag, ct] = blob.split(".");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64")].join("."), k)).toThrow();
  });

  it("returns null when no session has been saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    expect(await new SessionVault(join(dir, "none.enc"), key()).load()).toBeNull();
  });

  it("supports key rotation: old-key data is read and transparently re-encrypted under the new key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    const path = join(dir, "s.enc");
    const oldK = key();
    const newK = key();
    await new SessionVault(path, oldK).save(SECRET);
    expect(await new SessionVault(path, newK, oldK).load()).toBe(SECRET);
    expect(await new SessionVault(path, newK).load()).toBe(SECRET); // no longer needs the old key
  });

  it("rejects malformed keys with an actionable message", () => {
    expect(() => parseKey(undefined)).toThrow(/not set/);
    expect(() => parseKey("c2hvcnQ=")).toThrow(/32 random bytes/);
  });
});
