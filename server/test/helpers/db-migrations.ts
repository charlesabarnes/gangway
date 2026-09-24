import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.ts";
import { openDatabase as openBun } from "../../src/db/sqlite.ts";
import { openDatabase as openNode } from "../../src/db/sqlite.node.ts";
import type { Db, OpenOptions } from "../../src/db/types.ts";
import { MIGRATIONS, tempDir } from "./db.ts";

export type Open = (o: OpenOptions) => { db: Db; journalMode: string };

/** Every suite that uses these runs against both drivers, to keep the portability promise honest. */
export const DRIVERS: [string, Open][] = [
  ["bun:sqlite", openBun],
  ["node:sqlite", openNode],
];

export const ALL_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** A directory holding the real migrations up to and including `version`. */
export function migrationsUpTo(version: number): string {
  const dir = tempDir();
  for (const f of readdirSync(MIGRATIONS))
    if (Number.parseInt(f, 10) <= version) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  return dir;
}

/**
 * A database file migrated to `version`, open for seeding. `reopen()` closes it and
 * opens the same file again, as the next boot would.
 */
export function databaseAt(open: Open, version: number) {
  const path = join(tempDir(), "g.db");
  const { db } = open({ path });
  const applied = migrate(db, migrationsUpTo(version)).applied;
  return {
    db,
    applied,
    reopen: () => {
      db.close();
      return open({ path }).db;
    },
  };
}

/** A migrations directory holding exactly these files. */
export function migrationFiles(files: Record<string, string>): string {
  const d = join(tempDir(), "m");
  mkdirSync(d, { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}
