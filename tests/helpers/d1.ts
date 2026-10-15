import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";

// Vite's resolver doesn't know `node:sqlite` yet, so load it at runtime instead of through an import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncType;

/**
 * Minimal Cloudflare D1 emulation on Node's built-in SQLite (same engine family, FTS5 included).
 * Implements exactly the surface the API uses: prepare/bind/first/all/run and transactional batch.
 * Real migrations from /migrations are applied, so schema, constraints, triggers and FTS are the real ones.
 */
type Param = string | number | null | Uint8Array;

class Stmt {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly params: Param[] = []) {}
  /** Like real D1, bind() returns a NEW statement; the original stays reusable (`stmt.bind(a)`, `stmt.bind(b)`). */
  bind(...p: unknown[]): Stmt {
    const params = p.map((v) => {
      if (v === undefined) throw new Error("D1 does not accept undefined bindings (use null)");
      if (typeof v === "boolean") throw new Error("D1 does not accept boolean bindings");
      return v as Param;
    });
    return new Stmt(this.db, this.sql, params);
  }
  private stmt(): StatementSync { return this.db.prepare(this.sql); }
  /** @internal executes and returns rows + change count */
  exec(): { rows: Record<string, unknown>[]; changes: number; lastRowId: number } {
    const s = this.stmt();
    const returnsRows = /^\s*(select|with|pragma)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
    if (returnsRows) {
      const rows = s.all(...this.params) as Record<string, unknown>[];
      return { rows, changes: /^\s*select/i.test(this.sql) ? 0 : rows.length, lastRowId: 0 };
    }
    const r = s.run(...this.params);
    return { rows: [], changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const { rows } = this.exec();
    const row = rows[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const { rows, changes } = this.exec();
    return { results: rows as T[], success: true, meta: { changes } };
  }
  async run(): Promise<{ results: never[]; success: true; meta: { changes: number; last_row_id: number } }> {
    const { changes, lastRowId } = this.exec();
    return { results: [], success: true, meta: { changes, last_row_id: lastRowId } };
  }
}

export class FakeD1 {
  readonly raw: DatabaseSync;
  constructor() {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON");
    const dir = join(import.meta.dirname, "..", "..", "migrations");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      this.raw.exec(readFileSync(join(dir, f), "utf8"));
    }
  }
  prepare(sql: string): Stmt { return new Stmt(this.raw, sql); }
  /** D1 batches are atomic: all statements commit, or none do. */
  async batch(stmts: Stmt[]) {
    this.raw.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        const { rows, changes } = s.exec();
        return { results: rows, success: true, meta: { changes } };
      });
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  /** test helper */
  q<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
}
