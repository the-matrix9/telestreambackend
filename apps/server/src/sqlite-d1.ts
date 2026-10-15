/**
 * A small Cloudflare-D1-compatible database on Node's built-in SQLite (node:sqlite, Node >= 22.13).
 *
 * The API was written against D1's surface (prepare / bind / first / all / run / batch), so running it on a VPS
 * only needs this adapter: the SQL, FTS5 index, triggers and migrations are exactly the same. The test-suite runs
 * the API on the same engine, so behaviour is covered by tests.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Param = string | number | null | Uint8Array;

class Stmt {
  constructor(private readonly owner: SqliteD1, private readonly sql: string, private readonly params: Param[] = []) {}

  /** Like D1, bind() returns a NEW statement; the original stays reusable. */
  bind(...values: unknown[]): Stmt {
    const params = values.map((v) => {
      if (v === undefined) throw new Error("D1 does not accept undefined bindings (use null)");
      if (typeof v === "boolean") throw new Error("D1 does not accept boolean bindings");
      return v as Param;
    });
    return new Stmt(this.owner, this.sql, params);
  }

  /** @internal */
  exec(): { rows: Record<string, unknown>[]; changes: number; lastRowId: number } {
    const s = this.owner.statement(this.sql);
    const returnsRows = /^\s*(select|with|pragma)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
    if (returnsRows) {
      const rows = s.all(...this.params) as Record<string, unknown>[];
      return { rows, changes: /^\s*(select|with|pragma)\b/i.test(this.sql) ? 0 : rows.length, lastRowId: 0 };
    }
    const r = s.run(...this.params);
    return { rows: [], changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.exec().rows[0];
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

export class SqliteD1 {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    // WAL keeps readers (viewers) and the background sync writer from blocking each other.
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  /** @internal prepared statements are cached per SQL text */
  statement(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  prepare(sql: string): Stmt { return new Stmt(this, sql); }

  /** D1 batches are atomic: every statement commits, or none do. */
  async batch(stmts: Stmt[]) {
    this.raw.exec("BEGIN IMMEDIATE");
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

  close(): void { this.raw.close(); }
}

/** Applies every not-yet-applied migrations/*.sql file in name order. Returns the names that ran. */
export function migrate(db: SqliteD1, dir: string): string[] {
  db.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
  const done = new Set((db.raw.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  const ran: string[] = [];
  for (const file of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    db.raw.exec("BEGIN");
    try {
      db.raw.exec(readFileSync(join(dir, file), "utf8"));
      db.raw.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      db.raw.exec("COMMIT");
      ran.push(file);
    } catch (err) {
      db.raw.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return ran;
}
