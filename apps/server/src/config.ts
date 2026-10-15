import { z } from "zod";

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

const schema = z.object({
  /** Browser origin(s) of the frontend, comma separated, e.g. https://watch.example.com */
  APP_ORIGIN: z.string().min(1),
  /** Public https URL of THIS server, e.g. https://api.example.com (used to build absolute stream URLs). */
  API_PUBLIC_URL: z.string().url(),
  TG_SERVICE_URL: z.string().url().default("http://127.0.0.1:8788"),
  TG_SERVICE_SECRET: z.string().min(32, "use at least 32 random characters (same value as telegram-service)"),
  PLAYBACK_SECRET: z.string().min(32, "use at least 32 random characters"),
  SETUP_TOKEN: z.string().min(8),
  PASSWORD_PEPPER: z.string().min(16, "use at least 16 random characters; losing it locks admins out"),
  DATABASE_FILE: z.string().default("./data/telestream.db"),
  MIGRATIONS_DIR: z.string().default(""),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("0.0.0.0"),
  ENVIRONMENT: z.string().default("production"),
  /** "none" only if the frontend is on a different *site* than the API (e.g. *.pages.dev). Needs HTTPS. */
  COOKIE_SAMESITE: z.enum(["strict", "none"]).default("strict"),
  /** true when a reverse proxy (Caddy/nginx) sits in front: the client IP is taken from X-Forwarded-For. */
  TRUST_PROXY: bool,
  /** true only if Cloudflare proxies the API hostname: the client IP is taken from CF-Connecting-IP. */
  TRUST_CLOUDFLARE: bool,
});

export type ServerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server configuration:\n${lines}\nSee .env.example`);
  }
  return r.data;
}
