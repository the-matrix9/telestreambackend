import { verifyServiceRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@telestream/shared";
import { Hono } from "hono";
import { z } from "zod";
import { mapTelegramError, ServiceError } from "./errors";
import type { TelegramGateway } from "./gateway";
import { log } from "./logger";
import { buildStreamResponse, DEFAULT_LIMITS, StreamSlots, type StreamLimits } from "./streaming";

export interface AppDeps {
  gateway: TelegramGateway;
  serviceSecret: string;
  slots: StreamSlots;
  limits?: StreamLimits;
}

const startedAt = Date.now();
const channelRef = z.string().trim().min(1).max(64).regex(/^(-?[0-9]{5,20}|@?[A-Za-z][A-Za-z0-9_]{3,31})$/);

const schemas = {
  phone: z.object({ phone: z.string().regex(/^\+?[0-9]{7,15}$/) }),
  code: z.object({ code: z.string().regex(/^[0-9]{3,8}$/) }),
  password: z.object({ password: z.string().min(1).max(256) }),
  resolve: z.object({ channel: channelRef }),
  history: z.object({
    channel: channelRef,
    offsetId: z.number().int().min(0),
    floorId: z.number().int().min(0),
    limit: z.number().int().min(1).max(100),
  }),
  messages: z.object({ channel: channelRef, ids: z.array(z.number().int().positive()).min(1).max(100) }),
  media: z.object({ channel: channelRef, message: z.coerce.number().int().positive() }),
};

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ServiceError(400, "validation_error", r.error.issues[0]?.message ?? "Invalid input");
  return r.data;
}

export function createServiceApp(deps: AppDeps) {
  const { gateway, slots } = deps;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const app = new Hono();

  /**
   * Every /internal request must carry a fresh HMAC signature from the API Worker. This service is
   * not a public API and is never an open proxy: it only serves (channel, message) pairs the Worker asks for.
   */
  app.use("/internal/*", async (c, next) => {
    const url = new URL(c.req.url);
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? "" : await c.req.text();
    const ok = await verifyServiceRequest(deps.serviceSecret, c.req.method === "HEAD" ? "HEAD" : c.req.method, url.pathname + url.search, body, {
      timestamp: c.req.header(TIMESTAMP_HEADER),
      signature: c.req.header(SIGNATURE_HEADER),
    });
    if (!ok) return c.json({ error: { code: "unauthorized", message: "Bad signature" } }, 401);
    await next();
  });

  app.onError((err, c) => {
    const e = err instanceof ServiceError ? err : mapTelegramError(err);
    if (e.status >= 500) log("error", "service_error", { reason: e.code });
    if (e.retryAfter) c.header("Retry-After", String(e.retryAfter));
    return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
  });

  app.get("/internal/health", (c) =>
    c.json({ ok: true, version: "1.0.0", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), activeStreams: slots.inUse, telegram: gateway.state() }),
  );
  app.get("/internal/status", (c) => c.json(gateway.status()));

  app.post("/internal/login/request-code", async (c) => c.json(await gateway.requestCode(parse(schemas.phone, await c.req.json()).phone)));
  app.post("/internal/login/verify-code", async (c) => c.json(await gateway.verifyCode(parse(schemas.code, await c.req.json()).code)));
  app.post("/internal/login/verify-password", async (c) => c.json(await gateway.verifyPassword(parse(schemas.password, await c.req.json()).password)));
  app.post("/internal/logout", async (c) => c.json(await gateway.logout()));

  app.post("/internal/channels/resolve", async (c) => c.json(await gateway.resolveChannel(parse(schemas.resolve, await c.req.json()).channel)));
  app.post("/internal/history/page", async (c) => {
    const b = parse(schemas.history, await c.req.json());
    return c.json(await gateway.historyPage(b.channel, b.offsetId, b.floorId, b.limit));
  });
  app.post("/internal/messages/get", async (c) => {
    const b = parse(schemas.messages, await c.req.json());
    return c.json(await gateway.getMessages(b.channel, b.ids));
  });

  const stream = async (c: import("hono").Context): Promise<Response> => {
    const q = parse(schemas.media, { channel: c.req.query("channel"), message: c.req.query("message") });
    const source = await gateway.getMediaSource(q.channel, q.message);
    return buildStreamResponse(source, c.req.method, c.req.header("range") ?? null, slots, c.req.raw.signal, limits);
  };
  app.get("/internal/stream", stream);
  app.on("HEAD", "/internal/stream", stream);

  app.get("/internal/thumb", async (c) => {
    const q = parse(schemas.media, { channel: c.req.query("channel"), message: c.req.query("message") });
    const { bytes, mimeType } = await gateway.getThumbnail(q.channel, q.message);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mimeType, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, max-age=600" } });
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  return app;
}
