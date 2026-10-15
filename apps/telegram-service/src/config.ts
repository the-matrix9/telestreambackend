import { z } from "zod";

const schema = z.object({
  TG_API_ID: z.coerce.number().int().positive(),
  TG_API_HASH: z.string().min(16),
  SESSION_ENCRYPTION_KEY: z.string().min(40, "must be base64 of 32 random bytes"),
  SESSION_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  TG_SERVICE_SECRET: z.string().min(32, "use at least 32 random characters"),
  SESSION_FILE: z.string().default("./data/session.enc"),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("0.0.0.0"),
  MAX_CONCURRENT_STREAMS: z.coerce.number().int().min(1).max(500).default(24),
  MAX_RANGE_BYTES: z.coerce.number().int().min(256 * 1024).default(32 * 1024 * 1024),
  CHUNK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid telegram-service configuration:\n${lines}\nSee .env.example`);
  }
  return r.data;
}
