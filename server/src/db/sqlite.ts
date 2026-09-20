/**
 * THE ONLY FILE IN THE REPO THAT MAY IMPORT `bun:sqlite`.
 *
 * Everything else depends on the Db interface, which sqlite.node.ts also implements.
 * That fence is what makes §13's "keep code portable" a fact rather than an aspiration:
 * the fallback is a config flag, not a project.
 */
import { Database } from "bun:sqlite";
import { applyPragmas, compareVersion, MIN_SQLITE_VERSION, type Db, type OpenOptions, type Params } from "./types.ts";

class BunDb implements Db {
  readonly driver = "bun" as const;
  readonly sqliteVersion: string;
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
    this.sqliteVersion = String((db.query("select sqlite_version() as v").get() as any).v);
  }

  exec(sql: string) { this.#db.exec(sql); }
  query<T>(sql: string, params?: Params): T[] {
    return (params ? this.#db.query(sql).all(params as any) : this.#db.query(sql).all()) as T[];
  }
  get<T>(sql: string, params?: Params): T | undefined {
    // bun:sqlite returns null for "no row"; node:sqlite returns undefined.
    // Normalise here so callers see one contract across drivers.
    const r = params ? this.#db.query(sql).get(params as any) : this.#db.query(sql).get();
    return (r ?? undefined) as T | undefined;
  }
  run(sql: string, params?: Params) {
    const r = params ? this.#db.query(sql).run(params as any) : this.#db.query(sql).run();
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  transaction<T>(fn: () => T): T { return this.#db.transaction(fn)(); }
  pragma<T>(statement: string): T | undefined {
    return (this.#db.query(statement).get() ?? undefined) as T | undefined;
  }
  close() { this.#db.close(); }
}

export function openDatabase(o: OpenOptions): { db: Db; journalMode: string } {
  // strict:true gives sigil-free named parameters and THROWS on a missing binding
  // instead of silently binding NULL -- exactly the failure we want loud.
  const raw = new Database(o.path, { create: true, strict: true, readonly: o.readonly ?? false });
  const db = new BunDb(raw);

  if (!compareVersion(db.sqliteVersion, MIN_SQLITE_VERSION)) {
    throw new Error(
      `SQLite ${db.sqliteVersion} is older than the required ${MIN_SQLITE_VERSION.join(".")}. ` +
      `Note bun:sqlite links the system SQLite on macOS and a bundled one on Linux.`,
    );
  }
  const { journalMode } = applyPragmas(db, o);
  return { db, journalMode };
}
