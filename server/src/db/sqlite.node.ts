import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  applyPragmas,
  compareVersion,
  MIN_SQLITE_VERSION,
  type Db,
  type OpenOptions,
  type Params,
} from "./types.ts";

// node:sqlite takes no booleans.
type SqlParams = Record<string, SQLInputValue>;

class NodeDb implements Db {
  readonly driver = "node" as const;
  readonly sqliteVersion: string;
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.sqliteVersion = String(
      (db.prepare("select sqlite_version() as v").get() as { v: string }).v,
    );
  }

  #prep(sql: string) {
    const s = this.#db.prepare(sql);
    // Accept the bare parameter names bun:sqlite uses.
    s.setAllowBareNamedParameters(true);
    return s;
  }

  exec(sql: string) {
    this.#db.exec(sql);
  }
  query(sql: string, params?: Params): unknown[] {
    return params ? this.#prep(sql).all(params as SqlParams) : this.#prep(sql).all();
  }
  get(sql: string, params?: Params): unknown {
    const r = params ? this.#prep(sql).get(params as SqlParams) : this.#prep(sql).get();
    return r ?? undefined;
  }
  run(sql: string, params?: Params) {
    const r = params ? this.#prep(sql).run(params as SqlParams) : this.#prep(sql).run();
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
      } catch {
        // Nothing to roll back: the failure already ended the transaction.
      }
      throw e;
    }
  }
  pragma(statement: string): unknown {
    return this.#prep(statement).get() ?? undefined;
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
