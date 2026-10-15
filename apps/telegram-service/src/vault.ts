import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Encrypted session vault: AES-256-GCM, random 96-bit IV per write, file mode 0600.
 * The key comes from an environment secret and is never written next to the data.
 * File format:  v1.<iv b64>.<tag b64>.<ciphertext b64>
 * Supports decrypting with a previous key so keys can be rotated without re-login.
 */
export function parseKey(b64: string | undefined, label = "SESSION_ENCRYPTION_KEY"): Buffer {
  if (!b64) throw new Error(`${label} is not set`);
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`${label} must be 32 random bytes, base64-encoded (generate with: openssl rand -base64 32)`);
  return key;
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decrypt(blob: string, key: Buffer): string {
  const [v, iv, tag, ct] = blob.trim().split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised vault format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

export class SessionVault {
  constructor(
    private readonly path: string,
    private readonly key: Buffer,
    private readonly previousKey?: Buffer,
  ) {}

  async load(): Promise<string | null> {
    let blob: string;
    try {
      blob = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      return decrypt(blob, this.key);
    } catch {
      if (this.previousKey) {
        const plain = decrypt(blob, this.previousKey); // throws if neither key works
        await this.save(plain); // transparently re-encrypt under the current key
        return plain;
      }
      throw new Error("Session vault could not be decrypted. SESSION_ENCRYPTION_KEY is wrong or the file is corrupt.");
    }
  }

  async save(session: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, encrypt(session, this.key), { mode: 0o600 });
    await rename(tmp, this.path); // atomic replace
    await chmod(this.path, 0o600).catch(() => undefined);
  }

  async destroy(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
