import {
  signServiceRequest,
  type HistoryPageResponse,
  type IndexedVideo,
  type ResolvedChannel,
  type TelegramServiceStatus,
} from "@telestream/shared";
import type { Bindings } from "../env";
import { HttpError } from "./errors";

export interface MessageGetItem {
  messageId: number;
  exists: boolean;
  video: IndexedVideo | null;
}

/**
 * Client for the internal telegram-service. Every request is HMAC-signed; the service is the only
 * component that ever holds Telegram credentials or sessions.
 */
export class TelegramService {
  constructor(private readonly env: Bindings) {}

  private base(): string {
    return this.env.TG_SERVICE_URL.replace(/\/+$/, "");
  }

  /**
   * The timeout covers time-to-headers only and is cleared once headers arrive, so it never cuts a
   * long video body short. `signal` (e.g. the visitor's request signal) cancels the upstream stream.
   */
  private async send(
    method: string,
    pathWithQuery: string,
    body: unknown,
    extra: Record<string, string> = {},
    timeoutMs = 25_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const signed = await signServiceRequest(this.env.TG_SERVICE_SECRET, method, pathWithQuery, payload);
    const headers: Record<string, string> = { ...signed, ...extra };
    if (payload) headers["content-type"] = "application/json";
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(this.base() + pathWithQuery, {
        method,
        headers,
        body: payload || undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new HttpError(502, "telegram_service_unreachable", "The Telegram service is unreachable right now.", {
        cause: err instanceof Error ? err.name : "error",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const res = await this.send(method, path, body, {}, timeoutMs);
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as T;
  }

  private async toError(res: Response): Promise<HttpError> {
    let code = "telegram_service_error";
    let message = "The Telegram service reported an error.";
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      if (j.error?.code) code = j.error.code;
      if (j.error?.message) message = j.error.message;
    } catch {
      /* non-JSON error body */
    }
    const headers = res.headers.get("retry-after") ? { "Retry-After": res.headers.get("retry-after")! } : undefined;
    // Auth failures between our own services are a configuration problem, not the visitor's.
    if (res.status === 401) return new HttpError(502, "telegram_service_auth", "Telegram service rejected the API's signature. Check TG_SERVICE_SECRET.");
    if (res.status >= 500) return new HttpError(502, code, message, undefined, headers);
    return new HttpError(res.status, code, message, undefined, headers);
  }

  status() { return this.json<TelegramServiceStatus>("GET", "/internal/status"); }
  health() { return this.json<{ ok: boolean; version: string; uptimeSeconds: number; activeStreams: number }>("GET", "/internal/health", undefined, 6_000); }
  requestCode(phone: string) { return this.json<TelegramServiceStatus>("POST", "/internal/login/request-code", { phone }); }
  verifyCode(code: string) { return this.json<TelegramServiceStatus>("POST", "/internal/login/verify-code", { code }); }
  verifyPassword(password: string) { return this.json<TelegramServiceStatus>("POST", "/internal/login/verify-password", { password }); }
  logout() { return this.json<TelegramServiceStatus>("POST", "/internal/logout", {}); }
  resolveChannel(channel: string) { return this.json<ResolvedChannel>("POST", "/internal/channels/resolve", { channel }); }
  historyPage(channel: string, offsetId: number, floorId: number, limit: number) {
    return this.json<HistoryPageResponse>("POST", "/internal/history/page", { channel, offsetId, floorId, limit }, 60_000);
  }
  getMessages(channel: string, ids: number[]) {
    return this.json<{ items: MessageGetItem[] }>("POST", "/internal/messages/get", { channel, ids }, 60_000);
  }

  /** Streams a byte range. The Range header is forwarded; the service owns range semantics. */
  async stream(channel: string, messageId: number, method: "GET" | "HEAD", range: string | null, signal?: AbortSignal): Promise<Response> {
    const path = `/internal/stream?channel=${encodeURIComponent(channel)}&message=${messageId}`;
    const res = await this.send(method, path, undefined, range ? { range } : {}, 20_000, signal);
    if (res.status === 416 || res.status === 206 || res.status === 200) return res;
    throw await this.toError(res);
  }

  async thumbnail(channel: string, messageId: number): Promise<Response> {
    const path = `/internal/thumb?channel=${encodeURIComponent(channel)}&message=${messageId}`;
    const res = await this.send("GET", path, undefined, {}, 20_000);
    if (!res.ok) throw await this.toError(res);
    return res;
  }
}
