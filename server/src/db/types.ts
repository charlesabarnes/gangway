export type Params = Record<string, string | number | bigint | boolean | null | Uint8Array>;

export interface Db {
  exec(sql: string): void;
  query(sql: string, params?: Params): unknown[];
  get(sql: string, params?: Params): unknown;
  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number };
  transaction<T>(fn: () => T): T;
  pragma(statement: string): unknown;
  close(): void;
  readonly driver: "bun" | "node";
  readonly sqliteVersion: string;
}

export type OpenOptions = {
  path: string;
  journalMode?: "WAL" | "TRUNCATE";
  busyTimeoutMs?: number;
  readonly?: boolean;
};

export const MIN_SQLITE_VERSION = [3, 38, 0] as const;

export function compareVersion(v: string, min: readonly [number, number, number]): boolean {
  const parts = v.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    if (a > (min[i] ?? 0)) {
      return true;
    }
    if (a < (min[i] ?? 0)) {
      return false;
    }
  }
  return true;
}

// journal_mode=WAL can silently fail on some filesystems, and foreign_keys is per connection.
export function applyPragmas(
  db: Pick<Db, "pragma" | "exec">,
  o: OpenOptions,
): { journalMode: string } {
  const want = o.journalMode ?? "WAL";
  const res = db.pragma(`PRAGMA journal_mode = ${want}`) as { journal_mode: string } | undefined;
  const got = String(res?.journal_mode ?? "").toLowerCase();

  db.exec(`PRAGMA synchronous = NORMAL`);
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA busy_timeout = ${o.busyTimeoutMs ?? 5000}`);
  db.exec(`PRAGMA temp_store = MEMORY`);
  // 16 MiB of page cache (the default is 2); no mmap, which misbehaves on some network and FUSE filesystems.
  db.exec(`PRAGMA cache_size = -16384`);

  const fk = db.pragma(`PRAGMA foreign_keys`) as { foreign_keys: number } | undefined;
  if (Number(fk?.foreign_keys) !== 1) {
    throw new Error(
      "PRAGMA foreign_keys did not take effect; refusing to run without referential integrity",
    );
  }
  return { journalMode: got };
}
