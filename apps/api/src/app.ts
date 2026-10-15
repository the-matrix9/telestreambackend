import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv, Bindings } from "./env";
import { HttpError } from "./lib/errors";
import { log } from "./lib/log";
import { bodyLimit, cors, requestContext, securityHeaders } from "./middleware/security";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", requestContext);
  app.use("*", securityHeaders);
  app.use("*", cors);
  app.use("*", bodyLimit);

  app.route("/api", publicRoutes);
  app.route("/api/admin", adminRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) log("error", "http_error", { requestId: c.get("requestId"), reason: err.code, status: err.status });
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      c.header("Cache-Control", "no-store");
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: "validation_error", message: err.issues[0]?.message ?? "Invalid input" } }, 400);
    }
    // Unknown failure: log the cause server-side, return nothing internal.
    log("error", "unhandled", { requestId: c.get("requestId"), error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: { code: "internal_error", message: "Something went wrong.", details: { requestId: c.get("requestId") } } }, 500);
  });

  return app;
}
