/** The narrow database surface. Both drivers implement exactly this and nothing more. */
export type Params = Record<string, string | number | bigint | boolean | null | Uint8Array>;

export interface Db {
  exec(sql: string): void;
  query<T = unknown>(sql: string, params?: Params): T[];
  get<T = unknown>(sql: string, params?: Params): T | undefined;
  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number };
  /** Synchronous, so there is no await between statements and no interleaving. */
  transaction<T>(fn: () => T): T;
  pragma<T = unknown>(statement: string): T | undefined;
  close(): void;
  readonly driver: "bun" | "node";
  readonly sqliteVersion: string;
}

export type OpenOptions = {
  path: string;
  /** TRUNCATE is the fallback if WAL misbehaves on a FUSE filesystem. */
  journalMode?: "WAL" | "TRUNCATE";
  busyTimeoutMs?: number;
  readonly?: boolean;
};

export const MIN_SQLITE_VERSION = [3, 38, 0] as const;

export function compareVersion(v: string, min: readonly [number, number, number]): boolean {
  const parts = v.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    if (a > (min[i] ?? 0)) return true;
    if (a < (min[i] ?? 0)) return false;
  }
  return true;
}

/**
 * Shared open sequence. Order matters, and each step is checked rather than assumed:
 * `PRAGMA journal_mode=WAL` can silently fail on some filesystems, and foreign_keys is
 * OFF by default and is per-connection.
 */
export function applyPragmas(
  db: Pick<Db, "pragma" | "exec">,
  o: OpenOptions,
): { journalMode: string } {
  const want = o.journalMode ?? "WAL";
  const res = db.pragma<{ journal_mode: string }>(`PRAGMA journal_mode = ${want}`);
  const got = String(res?.journal_mode ?? "").toLowerCase();

  db.exec(`PRAGMA synchronous = NORMAL`);
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA busy_timeout = ${o.busyTimeoutMs ?? 5000}`);
  db.exec(`PRAGMA temp_store = MEMORY`);

  const fk = db.pragma<{ foreign_keys: number }>(`PRAGMA foreign_keys`);
  if (Number(fk?.foreign_keys) !== 1) {
    throw new Error("PRAGMA foreign_keys did not take effect; refusing to run without referential integrity");
  }
  return { journalMode: got };
}
