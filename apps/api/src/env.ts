export interface Bindings {
  DB: D1Database;
  RATE_KV?: KVNamespace;
  APP_ORIGIN: string;
  TG_SERVICE_URL: string;
  TG_SERVICE_SECRET: string;
  PLAYBACK_SECRET: string;
  SETUP_TOKEN: string;
  PASSWORD_PEPPER?: string;
  ENVIRONMENT?: string;
  /** Public origin of this API (e.g. https://api.example.com). Used to build absolute stream URLs for a separately hosted frontend. */
  API_PUBLIC_URL?: string;
  /** "none" when the frontend and API are on different sites (e.g. *.pages.dev + your own domain). Default "strict". */
  COOKIE_SAMESITE?: string;
  /** Set per request by the Node host (the real client address, already resolved behind the reverse proxy). */
  CLIENT_IP?: string;
}

export interface AdminContext {
  userId: number;
  username: string;
  csrf: string;
  sessionId: number;
}

export interface Variables {
  ip: string;
  requestId: string;
  admin?: AdminContext;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
