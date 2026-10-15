import type { AuditLogDTO } from "@telestream/shared";
import type { Bindings } from "../env";
import { redact } from "./log";

export async function audit(
  env: Bindings,
  entry: { actor: string | null; action: string; target?: string | null; ip?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO audit_log (actor, action, target, ip, metadata) VALUES (?, ?, ?, ?, ?)")
      .bind(
        entry.actor,
        entry.action,
        entry.target ?? null,
        entry.ip ?? null,
        entry.metadata ? JSON.stringify(redact(entry.metadata)) : null,
      )
      .run();
  } catch (err) {
    // Auditing must never take the request down, but failures should be visible.
    console.error(JSON.stringify({ level: "error", msg: "audit_write_failed", error: String(err) }));
  }
}

export async function listAudit(env: Bindings, limit: number): Promise<AuditLogDTO[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, actor, action, target, ip, created_at FROM audit_log ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .all<{ id: number; actor: string | null; action: string; target: string | null; ip: string | null; created_at: number }>();
  return results.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    ip: r.ip,
    createdAt: r.created_at,
  }));
}
