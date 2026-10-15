const SENSITIVE = /secret|token|password|passwd|code|hash|session|authorization|cookie|api_?hash|phone|key/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 3) return "[depth]";
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(x, depth + 1)]));
  }
  if (typeof v === "string" && v.length > 300) return v.slice(0, 300) + "…";
  return v;
}

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields) as object) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}
