/**
 * The `node:sqlite` twin of sqlite.ts, behind the same Db interface.
 *
 * Its purpose is to keep the portability promise honest: the whole repository test suite
 * runs against both drivers, so a Bun-specific assumption fails a test rather than
 * discovering itself during a migration off Bun.
 */
import { DatabaseSync } from "node:sqlite";
import {
  applyPragmas,
  compareVersion,
  MIN_SQLITE_VERSION,
  type Db,
  type OpenOptions,
  type Params,
} from "./types.ts";

class NodeDb implements Db {
  readonly driver = "node" as const;
  readonly sqliteVersion: string;
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.sqliteVersion = String((db.prepare("select sqlite_version() as v").get() as any).v);
  }

  #prep(sql: string) {
    const s = this.#db.prepare(sql);
    // node:sqlite wants `$name` keys by default; allow the bare names bun:sqlite uses
    // so callers write one dialect.
    s.setAllowBareNamedParameters?.(true);
    return s;
  }

  exec(sql: string) {
    this.#db.exec(sql);
  }
  query<T>(sql: string, params?: Params): T[] {
    return (params ? this.#prep(sql).all(params as any) : this.#prep(sql).all()) as T[];
  }
  get<T>(sql: string, params?: Params): T | undefined {
    const r = params ? this.#prep(sql).get(params as any) : this.#prep(sql).get();
    return (r ?? undefined) as T | undefined;
  }
  run(sql: string, params?: Params) {
    const r = params ? this.#prep(sql).run(params as any) : this.#prep(sql).run();
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const v = fn();
      this.#db.exec("COMMIT");
      return v;
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
  pragma<T>(statement: string): T | undefined {
    return (this.#prep(statement).get() ?? undefined) as T | undefined;
  }
  close() {
    this.#db.close();
  }
}

export function openDatabase(o: OpenOptions): { db: Db; journalMode: string } {
  const raw = new DatabaseSync(o.path, { open: true, readOnly: o.readonly ?? false });
  const db = new NodeDb(raw);
  if (!compareVersion(db.sqliteVersion, MIN_SQLITE_VERSION)) {
    throw new Error(
      `SQLite ${db.sqliteVersion} is older than the required ${MIN_SQLITE_VERSION.join(".")}`,
    );
  }
  const { journalMode } = applyPragmas(db, o);
  return { db, journalMode };
}
