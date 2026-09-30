import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Migration } from "./migrate.ts";
import type { Db } from "./types.ts";

export const KEEP_BACKUPS = 5;

const BACKUP_RE = /^(.+)-pre-(\d{4})-(\d+)\.db$/;

// install.sh --rollback puts this file back. VACUUM INTO is a consistent copy even in WAL mode.
export function backupBeforeMigrating(
  db: Db,
  dbPath: string,
  pending: readonly Migration[],
  now: () => number = Date.now,
): string {
  const dir = join(dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });
  const name = basename(dbPath).replace(/\.db$/, "");
  const [next] = pending;
  if (!next) {
    throw new Error("no pending migration to back up for");
  }
  const first = String(next.version).padStart(4, "0");
  const file = join(dir, `${name}-pre-${first}-${now()}.db`);
  db.run("VACUUM INTO $file", { file });

  const ours = readdirSync(dir)
    .flatMap((f) => {
      const m = BACKUP_RE.exec(f);
      return m?.[1] === name ? [{ f, at: Number(m[3]) }] : [];
    })
    .sort((a, b) => b.at - a.at);
  for (const { f } of ours.slice(KEEP_BACKUPS)) {
    rmSync(join(dir, f));
  }
  return file;
}
